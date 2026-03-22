//! Sandbox lifecycle handlers.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use std::sync::Arc;

use std::time::Duration;

use crate::agent::{vm_data_dir, AgentManager, HostMount};
use crate::api::error::{classify_ensure_running_error, ApiError};
use crate::api::state::{
    ensure_running_and_persist, ensure_sandbox_running, restart_spec_to_config, with_sandbox_client,
    ApiState, ReservationGuard, SandboxRegistration,
};
use crate::api::types::{
    ApiErrorResponse, CloneSandboxRequest, CreateSandboxRequest, DebugMountsResponse,
    DebugNetworkResponse, DeleteQuery, DeleteResponse, DiffResponse, DnsFilterStatus,
    ListSandboxesResponse, MergeResponse, MergeSandboxRequest, MergeStrategy, MountInfo,
    MountSpec, ResourceSpec, SandboxInfo,
};
use crate::api::auth::{check_permission, extract_bearer_token, hash_token};
use crate::api::validation::validate_resource_name;
use crate::api::types::SandboxRole;
use crate::config::RecordState;
use crate::storage::{clone_or_copy_file, OverlayDisk, StorageDisk, OVERLAY_DISK_FILENAME, STORAGE_DISK_FILENAME};

/// Maximum sandbox name length.
/// Socket path is ~/Library/Caches/smolvm/vms/{name}/agent.sock — a name
/// of 40 chars results in a socket path of ~90 chars, leaving some margin.
const MAX_NAME_LENGTH: usize = 40;

/// Convert MountSpec list to MountInfo list with virtiofs tags.
pub(crate) fn mounts_to_info(mounts: &[MountSpec]) -> Vec<MountInfo> {
    mounts
        .iter()
        .enumerate()
        .map(|(i, m)| MountInfo {
            tag: crate::agent::mount_tag(i),
            source: m.source.clone(),
            target: m.target.clone(),
            readonly: m.readonly,
        })
        .collect()
}

/// Build a SandboxInfo from a locked SandboxEntry.
pub(crate) fn sandbox_entry_to_info(
    name: String,
    entry: &crate::api::state::SandboxEntry,
) -> SandboxInfo {
    let (effective_state, pid) = entry.manager.effective_status();
    SandboxInfo {
        name,
        state: effective_state.to_string(),
        pid,
        mounts: mounts_to_info(&entry.mounts),
        ports: entry.ports.clone(),
        resources: entry.resources.clone(),
        network: entry.network,
        restart_count: if entry.restart.restart_count > 0 {
            Some(entry.restart.restart_count)
        } else {
            None
        },
    }
}

/// Create a new sandbox.
#[utoipa::path(
    post,
    path = "/api/v1/sandboxes",
    tag = "Sandboxes",
    request_body = CreateSandboxRequest,
    responses(
        (status = 200, description = "Sandbox created", body = SandboxInfo),
        (status = 400, description = "Invalid request", body = ApiErrorResponse),
        (status = 409, description = "Sandbox already exists", body = ApiErrorResponse)
    )
)]
pub async fn create_sandbox(
    State(state): State<Arc<ApiState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateSandboxRequest>,
) -> Result<Json<SandboxInfo>, ApiError> {
    let _create_start = std::time::Instant::now();

    // Extract owner token hash for RBAC (None if no auth configured)
    let owner_token_hash = extract_bearer_token(&headers).map(|t| hash_token(&t));

    // Validate name format
    validate_resource_name(&req.name, "sandbox", MAX_NAME_LENGTH)?;

    // Validate mounts
    let mounts_result: Result<Vec<_>, _> = req.mounts.iter().map(HostMount::try_from).collect();
    mounts_result.map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let resources = req.resources.clone().unwrap_or(ResourceSpec {
        cpus: None,
        memory_mb: None,
        network: None,
        storage_gb: None,
        overlay_gb: None,
        allowed_domains: None,
    });

    // Get network setting from resources (default to false).
    // If allowed_domains is set, network is implicitly enabled.
    let has_allowed_domains = resources
        .allowed_domains
        .as_ref()
        .map_or(false, |d| !d.is_empty());
    let network = resources.network.unwrap_or(false) || has_allowed_domains;

    // Parse restart configuration
    let restart_config = restart_spec_to_config(req.restart.as_ref());

    // Reserve name with RAII guard - automatically released on any error or panic
    let guard = ReservationGuard::new(&state, req.name.clone())?;

    // Create AgentManager in blocking task
    let name = guard.name().to_string();
    let storage_gb = resources.storage_gb;
    let overlay_gb = resources.overlay_gb;
    let manager_result = tokio::task::spawn_blocking(move || {
        AgentManager::for_vm_with_sizes(&name, storage_gb, overlay_gb)
    })
    .await;

    // Handle manager creation result - guard auto-releases on error return
    let manager = match manager_result {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => return Err(ApiError::internal(e)),
        Err(e) => return Err(ApiError::internal(e)),
    };

    // Get state for response before completing registration
    let agent_state = manager.state().to_string();
    let pid = manager.child_pid();

    // Validate and configure secrets
    let (secrets, default_env) = if !req.secrets.is_empty() {
        let config_guard = state.proxy_config.read();
        if let Some(ref proxy_config) = *config_guard {
            if let Err(missing) = crate::proxy::validate_secret_names(&req.secrets, proxy_config) {
                return Err(ApiError::BadRequest(format!(
                    "secrets not configured on server: {:?}. Use --secret NAME=VALUE when starting the server.",
                    missing
                )));
            }
            let env_vars = proxy_config.env_vars_for_secrets(&req.secrets);
            (req.secrets.clone(), env_vars)
        } else {
            return Err(ApiError::BadRequest(
                "secrets requested but no secrets configured on server. Use --secret NAME=VALUE when starting the server.".to_string()
            ));
        }
    } else {
        (Vec::new(), Vec::new())
    };

    // If secrets are requested, network must be enabled (for the proxy to reach APIs)
    let network = network || !secrets.is_empty();

    // Complete registration - consumes the guard
    guard.complete(SandboxRegistration {
        manager,
        mounts: req.mounts.clone(),
        ports: req.ports.clone(),
        resources: resources.clone(),
        restart: restart_config,
        network,
        allowed_domains: resources.allowed_domains.clone(),
        secrets,
        default_env,
        owner_token_hash,
        mcp_servers: req.mcp_servers.clone(),
    })?;

    // Apply starter configuration if requested
    let mut extra_init_commands: Vec<String> = Vec::new();
    let mut effective_default_user = req.default_user.clone();
    if let Some(ref starter_name) = req.from_starter {
        if let Some(starter) = crate::api::starters::get_starter(starter_name) {
            // Merge starter init_commands (starter first, then user's)
            extra_init_commands.extend(starter.init_commands.iter().map(|s| s.to_string()));
            // Use starter's default_user if user didn't specify one
            if effective_default_user.is_none() {
                effective_default_user = starter.default_user.map(|s| s.to_string());
            }
            tracing::info!(
                sandbox = %req.name,
                starter = %starter_name,
                "applying starter configuration"
            );
        } else {
            return Err(ApiError::BadRequest(format!(
                "unknown starter '{}'; use GET /api/v1/starters to list available starters",
                starter_name
            )));
        }
    }

    // Create default user if requested
    let has_default_user = effective_default_user.is_some();
    if let Some(ref user) = effective_default_user {
        let entry = state.get_sandbox(&req.name)?;
        ensure_running_and_persist(&state, &req.name, &entry)
            .await
            .map_err(classify_ensure_running_error)?;

        let adduser_cmd = format!("id {0} >/dev/null 2>&1 || adduser -D {0}", user);
        let cmd = adduser_cmd;
        let (exit_code, _stdout, stderr) =
            with_sandbox_client(&entry, move |c| {
                c.vm_exec(
                    vec!["sh".into(), "-c".into(), cmd],
                    vec![],
                    None,
                    Some(Duration::from_secs(30)),
                )
            })
            .await?;

        if exit_code != 0 {
            tracing::warn!(
                sandbox = %req.name,
                user = %user,
                exit_code,
                stderr = %stderr,
                "default_user creation failed"
            );
        }
    }

    // Prepend DNS filter commands if allowed_domains is set.
    // These run BEFORE starter/user init commands so filtering is active
    // before any user code executes.
    if has_allowed_domains {
        let dns_cmds = crate::api::dns_filter::dns_filter_init_commands(
            resources.allowed_domains.as_deref().unwrap_or(&[]),
        );
        // Convert argv-style commands to shell strings for the init pipeline
        let dns_shell_cmds: Vec<String> = dns_cmds
            .into_iter()
            .map(|argv| {
                // argv is ["sh", "-c", "<script>"] — extract the script
                if argv.len() == 3 && argv[0] == "sh" && argv[1] == "-c" {
                    argv[2].clone()
                } else {
                    argv.join(" ")
                }
            })
            .collect();
        // Insert DNS filter commands at the front
        let mut with_dns = dns_shell_cmds;
        with_dns.append(&mut extra_init_commands);
        extra_init_commands = with_dns;
        tracing::info!(
            sandbox = %req.name,
            domains = ?resources.allowed_domains,
            "DNS egress filtering will be configured"
        );
    }

    // Combine starter init commands + user init commands
    extra_init_commands.extend(req.init_commands.iter().cloned());
    let all_init_commands = extra_init_commands;

    // Run init commands if any were provided
    if !all_init_commands.is_empty() {
        let entry = state.get_sandbox(&req.name)?;
        ensure_running_and_persist(&state, &req.name, &entry)
            .await
            .map_err(classify_ensure_running_error)?;

        // Prepare default env vars for init commands (e.g., proxy BASE_URL + placeholder)
        let init_env = {
            let entry_lock = entry.lock();
            entry_lock.default_env.clone()
        };

        for cmd in &all_init_commands {
            let cmd_for_exec = cmd.clone();
            let env_for_cmd = init_env.clone();
            let (exit_code, _stdout, stderr) =
                with_sandbox_client(&entry, move |c| {
                    c.vm_exec(
                        vec!["sh".into(), "-c".into(), cmd_for_exec],
                        env_for_cmd,
                        None,
                        Some(Duration::from_secs(120)),
                    )
                })
                .await?;

            if exit_code != 0 {
                tracing::warn!(
                    sandbox = %req.name,
                    cmd = %cmd,
                    exit_code,
                    stderr = %stderr,
                    "init command failed"
                );
            }
        }

        // Re-read state after init commands (VM is now running)
        let entry = state.get_sandbox(&req.name)?;
        let entry_lock = entry.lock();
        crate::api::metrics::record_sandbox_created();
        crate::api::metrics::record_sandbox_boot_time(_create_start.elapsed().as_secs_f64());
        return Ok(Json(sandbox_entry_to_info(req.name.clone(), &entry_lock)));
    }

    // If default_user was set (VM started for user creation), return updated state
    if has_default_user {
        let entry = state.get_sandbox(&req.name)?;
        let entry_lock = entry.lock();
        crate::api::metrics::record_sandbox_created();
        crate::api::metrics::record_sandbox_boot_time(_create_start.elapsed().as_secs_f64());
        return Ok(Json(sandbox_entry_to_info(req.name.clone(), &entry_lock)));
    }

    crate::api::metrics::record_sandbox_created();
    crate::api::metrics::record_sandbox_boot_time(_create_start.elapsed().as_secs_f64());
    Ok(Json(SandboxInfo {
        name: req.name.clone(),
        state: agent_state,
        pid,
        mounts: mounts_to_info(&req.mounts),
        ports: req.ports,
        resources,
        network,
        restart_count: None,
    }))
}

/// List all sandboxes.
#[utoipa::path(
    get,
    path = "/api/v1/sandboxes",
    tag = "Sandboxes",
    responses(
        (status = 200, description = "List of sandboxes", body = ListSandboxesResponse)
    )
)]
pub async fn list_sandboxes(State(state): State<Arc<ApiState>>) -> Json<ListSandboxesResponse> {
    let sandboxes = state.list_sandboxes();
    Json(ListSandboxesResponse { sandboxes })
}

/// Get sandbox status.
#[utoipa::path(
    get,
    path = "/api/v1/sandboxes/{id}",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Sandbox name")
    ),
    responses(
        (status = 200, description = "Sandbox details", body = SandboxInfo),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse)
    )
)]
pub async fn get_sandbox(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<SandboxInfo>, ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, SandboxRole::ReadOnly)?;
    }
    let entry = state.get_sandbox(&id)?;
    let entry = entry.lock();
    Ok(Json(sandbox_entry_to_info(id, &entry)))
}

/// Start a sandbox.
#[utoipa::path(
    post,
    path = "/api/v1/sandboxes/{id}/start",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Sandbox name")
    ),
    responses(
        (status = 200, description = "Sandbox started", body = SandboxInfo),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Failed to start", body = ApiErrorResponse)
    )
)]
pub async fn start_sandbox(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<SandboxInfo>, ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, SandboxRole::Operator)?;
    }
    let entry = state.get_sandbox(&id)?;

    // Snapshot configuration for response
    let (mounts_spec, ports_spec, resources_spec, network) = {
        let entry = entry.lock();
        (
            entry.mounts.clone(),
            entry.ports.clone(),
            entry.resources.clone(),
            entry.network,
        )
    };

    // Clear user_stopped flag since user is explicitly starting
    state.mark_user_stopped(&id, false);

    // Start sandbox (child process closes inherited fds, so DB stays open).
    ensure_sandbox_running(&entry)
        .await
        .map_err(classify_ensure_running_error)?;

    // Get updated state and persist
    let (agent_state, pid) = {
        let entry = entry.lock();
        let agent_state = entry.manager.state().to_string();
        let pid = entry.manager.child_pid();
        (agent_state, pid)
    };

    // Reset restart count on successful user-initiated start
    state.reset_restart_count(&id);

    // Persist state to config
    state
        .update_sandbox_state(&id, RecordState::Running, pid)
        .map_err(ApiError::database)?;

    Ok(Json(SandboxInfo {
        name: id,
        state: agent_state,
        pid,
        mounts: mounts_to_info(&mounts_spec),
        ports: ports_spec,
        resources: resources_spec,
        network,
        restart_count: None, // Just reset
    }))
}

/// Stop a sandbox.
#[utoipa::path(
    post,
    path = "/api/v1/sandboxes/{id}/stop",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Sandbox name")
    ),
    responses(
        (status = 200, description = "Sandbox stopped", body = SandboxInfo),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Failed to stop", body = ApiErrorResponse)
    )
)]
pub async fn stop_sandbox(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<SandboxInfo>, ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, SandboxRole::Operator)?;
    }
    let entry = state.get_sandbox(&id)?;

    // Get config for response
    let (mounts_spec, ports_spec, resources_spec, network, restart_count) = {
        let entry = entry.lock();
        (
            entry.mounts.clone(),
            entry.ports.clone(),
            entry.resources.clone(),
            entry.network,
            if entry.restart.restart_count > 0 {
                Some(entry.restart.restart_count)
            } else {
                None
            },
        )
    };

    // Mark as user-stopped before stopping (prevents auto-restart)
    state.mark_user_stopped(&id, true);

    // Stop the sandbox in a blocking task (clone Arc<AgentManager> to avoid holding entry lock)
    let manager = {
        let entry = entry.lock();
        std::sync::Arc::clone(&entry.manager)
    };
    let stop_result = tokio::task::spawn_blocking(move || {
        manager.stop()
    })
    .await?;

    if let Err(e) = stop_result {
        // Roll back user_stopped so the supervisor can still restart if configured
        state.mark_user_stopped(&id, false);
        return Err(ApiError::internal(e));
    }

    // Get updated state and persist
    let (agent_state, pid) = {
        let entry = entry.lock();
        let agent_state = entry.manager.state().to_string();
        let pid = entry.manager.child_pid();
        (agent_state, pid)
    };

    // Persist state to config
    state
        .update_sandbox_state(&id, RecordState::Stopped, None)
        .map_err(ApiError::database)?;

    Ok(Json(SandboxInfo {
        name: id,
        state: agent_state,
        pid,
        mounts: mounts_to_info(&mounts_spec),
        ports: ports_spec,
        resources: resources_spec,
        network,
        restart_count,
    }))
}

/// Delete a sandbox.
#[utoipa::path(
    delete,
    path = "/api/v1/sandboxes/{id}",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Sandbox name"),
        ("force" = Option<bool>, Query, description = "Force delete even if VM is still running")
    ),
    responses(
        (status = 200, description = "Sandbox deleted", body = DeleteResponse),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse),
        (status = 409, description = "VM still running, use force=true", body = ApiErrorResponse)
    )
)]
pub async fn delete_sandbox(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Query(query): Query<DeleteQuery>,
) -> Result<Json<DeleteResponse>, ApiError> {
    // Owner-only operation
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, SandboxRole::Owner)?;
    }
    // First, get the entry and stop the sandbox (before removing from registry).
    let entry = state.get_sandbox(&id)?;

    // Stop the sandbox if running (clone Arc<AgentManager> to avoid holding entry lock)
    let manager = {
        let entry = entry.lock();
        std::sync::Arc::clone(&entry.manager)
    };
    let stop_result = tokio::task::spawn_blocking(move || {
        manager.stop()
    })
    .await?;

    // Handle stop errors
    if let Err(ref e) = stop_result {
        // Check if VM process is actually still alive using start-time-aware
        // verification across both child handle and PID file.
        let still_running = {
            let entry = entry.lock();
            entry.manager.is_process_alive()
        };

        if still_running && !query.force {
            // VM is still running and force not specified - refuse to orphan it
            return Err(ApiError::Conflict(format!(
                "failed to stop sandbox '{}': {}. VM is still running. \
                 Use ?force=true to delete anyway (will orphan the VM process)",
                id, e
            )));
        }

        // Either VM is not running, or force=true - proceed with warning
        tracing::warn!(
            sandbox = %id,
            error = %e,
            still_running = still_running,
            force = query.force,
            "stop failed during delete, proceeding with removal"
        );
    }

    // Now remove from registry and database
    state.remove_sandbox(&id)?;

    crate::api::metrics::record_sandbox_deleted();
    Ok(Json(DeleteResponse { deleted: id }))
}

/// Clone an existing sandbox.
///
/// Creates a new sandbox by copying the overlay and storage disks from an
/// existing sandbox. On macOS with APFS, this is instant (copy-on-write).
/// The source sandbox does not need to be stopped.
#[utoipa::path(
    post,
    path = "/api/v1/sandboxes/{id}/clone",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Source sandbox name")
    ),
    request_body = CloneSandboxRequest,
    responses(
        (status = 200, description = "Sandbox cloned", body = SandboxInfo),
        (status = 400, description = "Invalid request", body = ApiErrorResponse),
        (status = 404, description = "Source sandbox not found", body = ApiErrorResponse),
        (status = 409, description = "Clone name already exists", body = ApiErrorResponse)
    )
)]
pub async fn clone_sandbox(
    State(state): State<Arc<ApiState>>,
    Path(source_id): Path<String>,
    Json(req): Json<CloneSandboxRequest>,
) -> Result<Json<SandboxInfo>, ApiError> {
    // Validate clone name
    validate_resource_name(&req.name, "sandbox", MAX_NAME_LENGTH)?;

    // Verify source exists and snapshot its config
    let (source_resources, source_network) = {
        let source_entry = state.get_sandbox(&source_id)?;
        let entry = source_entry.lock();
        (entry.resources.clone(), entry.network)
    };

    // Reserve the clone name
    let guard = ReservationGuard::new(&state, req.name.clone())?;

    // Copy disks and create manager in blocking task
    let clone_name = guard.name().to_string();
    let source_name = source_id.clone();
    let manager_result = tokio::task::spawn_blocking(move || {
        let source_dir = vm_data_dir(&source_name);
        let clone_dir = vm_data_dir(&clone_name);
        std::fs::create_dir_all(&clone_dir)
            .map_err(|e| crate::error::Error::storage("create clone dir", e.to_string()))?;

        // Copy storage disk (APFS CoW on macOS = instant)
        let src_storage = source_dir.join(STORAGE_DISK_FILENAME);
        let dst_storage = clone_dir.join(STORAGE_DISK_FILENAME);
        if src_storage.exists() {
            clone_or_copy_file(&src_storage, &dst_storage)?;
            // Copy format marker too
            let src_marker = src_storage.with_extension("formatted");
            let dst_marker = dst_storage.with_extension("formatted");
            if src_marker.exists() {
                let _ = std::fs::copy(&src_marker, &dst_marker);
            }
        }

        // Copy overlay disk
        let src_overlay = source_dir.join(OVERLAY_DISK_FILENAME);
        let dst_overlay = clone_dir.join(OVERLAY_DISK_FILENAME);
        if src_overlay.exists() {
            clone_or_copy_file(&src_overlay, &dst_overlay)?;
            let src_marker = src_overlay.with_extension("formatted");
            let dst_marker = dst_overlay.with_extension("formatted");
            if src_marker.exists() {
                let _ = std::fs::copy(&src_marker, &dst_marker);
            }
        }

        // Open disks at the new paths (they already exist from the copy)
        let storage_gb = source_resources.storage_gb;
        let overlay_gb = source_resources.overlay_gb;
        let storage_disk = StorageDisk::open_or_create_at(
            &dst_storage,
            storage_gb.unwrap_or(crate::storage::DEFAULT_STORAGE_SIZE_GB),
        )?;
        let overlay_disk = OverlayDisk::open_or_create_at(
            &dst_overlay,
            overlay_gb.unwrap_or(crate::storage::DEFAULT_OVERLAY_SIZE_GB),
        )?;

        // Create manager from existing disks
        let rootfs_path = AgentManager::default_rootfs_path()?;
        AgentManager::new_named(&clone_name, rootfs_path, storage_disk, overlay_disk)
    })
    .await;

    let manager = match manager_result {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => return Err(ApiError::internal(e)),
        Err(e) => return Err(ApiError::internal(e)),
    };

    let agent_state = manager.state().to_string();
    let pid = manager.child_pid();

    // Register with same config as source (no mounts/ports since those are host-specific)
    let restart_config = crate::config::RestartConfig::default();
    let source_allowed_domains = {
        let source_entry = state.get_sandbox(&source_id)?;
        let entry = source_entry.lock();
        entry.allowed_domains.clone()
    };
    guard.complete(SandboxRegistration {
        manager,
        mounts: vec![],
        ports: vec![],
        resources: source_resources.clone(),
        restart: restart_config,
        network: source_network,
        allowed_domains: source_allowed_domains,
        secrets: Vec::new(),
        default_env: Vec::new(),
        owner_token_hash: None,
        mcp_servers: Vec::new(),
    })?;

    Ok(Json(SandboxInfo {
        name: req.name,
        state: agent_state,
        pid,
        mounts: vec![],
        ports: vec![],
        resources: source_resources,
        network: source_network,
        restart_count: None,
    }))
}

/// Compare two sandboxes.
///
/// Lists files that differ between two sandboxes by executing commands
/// inside each VM and comparing the results.
#[utoipa::path(
    get,
    path = "/api/v1/sandboxes/{id}/diff/{other}",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "First sandbox name"),
        ("other" = String, Path, description = "Second sandbox name")
    ),
    responses(
        (status = 200, description = "Diff result", body = DiffResponse),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Diff failed", body = ApiErrorResponse)
    )
)]
pub async fn diff_sandboxes(
    State(state): State<Arc<ApiState>>,
    Path((id, other)): Path<(String, String)>,
) -> Result<Json<DiffResponse>, ApiError> {
    // Get both sandbox entries
    let entry_a = state.get_sandbox(&id)?;
    let entry_b = state.get_sandbox(&other)?;

    // Ensure both are running
    ensure_running_and_persist(&state, &id, &entry_a)
        .await
        .map_err(classify_ensure_running_error)?;
    ensure_running_and_persist(&state, &other, &entry_b)
        .await
        .map_err(classify_ensure_running_error)?;

    // Get file listing with checksums from both sandboxes
    // Exclude /proc, /sys, /dev, /tmp to focus on meaningful differences
    let hash_cmd = vec![
        "sh".to_string(),
        "-c".to_string(),
        "find / -xdev -type f ! -path '/proc/*' ! -path '/sys/*' ! -path '/dev/*' ! -path '/tmp/*' ! -path '/run/*' -exec md5sum {} \\; 2>/dev/null | sort".to_string(),
    ];

    let cmd_a = hash_cmd.clone();
    let (_, stdout_a, _) = with_sandbox_client(&entry_a, move |c| {
        c.vm_exec(cmd_a, vec![], None, Some(Duration::from_secs(60)))
    })
    .await?;

    let cmd_b = hash_cmd;
    let (_, stdout_b, _) = with_sandbox_client(&entry_b, move |c| {
        c.vm_exec(cmd_b, vec![], None, Some(Duration::from_secs(60)))
    })
    .await?;

    // Parse and compare
    let files_a: std::collections::HashMap<&str, &str> = stdout_a
        .lines()
        .filter_map(|line| line.split_once("  "))
        .map(|(hash, path)| (path, hash))
        .collect();

    let files_b: std::collections::HashMap<&str, &str> = stdout_b
        .lines()
        .filter_map(|line| line.split_once("  "))
        .map(|(hash, path)| (path, hash))
        .collect();

    let mut differences = Vec::new();

    // Files in A but not in B, or different hash
    for (path, hash_a) in &files_a {
        match files_b.get(path) {
            None => differences.push(format!("- {}", path)),
            Some(hash_b) if hash_a != hash_b => differences.push(format!("~ {}", path)),
            _ => {}
        }
    }

    // Files in B but not in A
    for path in files_b.keys() {
        if !files_a.contains_key(path) {
            differences.push(format!("+ {}", path));
        }
    }

    differences.sort();

    Ok(Json(DiffResponse {
        source: id,
        target: other,
        identical: differences.is_empty(),
        differences,
    }))
}

/// Merge files from one sandbox into another.
///
/// Transfers changed files from the source sandbox to the target sandbox.
/// Uses the diff output to identify changed files, then copies them via
/// base64-encoded exec channel.
#[utoipa::path(
    post,
    path = "/api/v1/sandboxes/{id}/merge/{target}",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Source sandbox name"),
        ("target" = String, Path, description = "Target sandbox name")
    ),
    request_body = MergeSandboxRequest,
    responses(
        (status = 200, description = "Merge result", body = MergeResponse),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Merge failed", body = ApiErrorResponse)
    )
)]
pub async fn merge_sandboxes(
    State(state): State<Arc<ApiState>>,
    Path((source_id, target_id)): Path<(String, String)>,
    Json(req): Json<MergeSandboxRequest>,
) -> Result<Json<MergeResponse>, ApiError> {
    // Get both sandbox entries
    let entry_source = state.get_sandbox(&source_id)?;
    let entry_target = state.get_sandbox(&target_id)?;

    // Ensure both are running
    ensure_running_and_persist(&state, &source_id, &entry_source)
        .await
        .map_err(classify_ensure_running_error)?;
    ensure_running_and_persist(&state, &target_id, &entry_target)
        .await
        .map_err(classify_ensure_running_error)?;

    // Get file listing with checksums from both sandboxes (reuse diff logic)
    let hash_cmd = vec![
        "sh".to_string(),
        "-c".to_string(),
        "find / -xdev -type f ! -path '/proc/*' ! -path '/sys/*' ! -path '/dev/*' ! -path '/tmp/*' ! -path '/run/*' -exec md5sum {} \\; 2>/dev/null | sort".to_string(),
    ];

    let cmd_s = hash_cmd.clone();
    let (_, stdout_source, _) = with_sandbox_client(&entry_source, move |c| {
        c.vm_exec(cmd_s, vec![], None, Some(Duration::from_secs(60)))
    })
    .await?;

    let cmd_t = hash_cmd;
    let (_, stdout_target, _) = with_sandbox_client(&entry_target, move |c| {
        c.vm_exec(cmd_t, vec![], None, Some(Duration::from_secs(60)))
    })
    .await?;

    // Parse checksums
    let files_source: std::collections::HashMap<&str, &str> = stdout_source
        .lines()
        .filter_map(|line| line.split_once("  "))
        .map(|(hash, path)| (path, hash))
        .collect();

    let files_target: std::collections::HashMap<&str, &str> = stdout_target
        .lines()
        .filter_map(|line| line.split_once("  "))
        .map(|(hash, path)| (path, hash))
        .collect();

    // Find files that differ (in source but different/missing in target)
    let mut to_merge: Vec<String> = Vec::new();
    for (path, hash_s) in &files_source {
        let differs = match files_target.get(path) {
            None => true,
            Some(hash_t) => hash_s != hash_t,
        };
        if differs {
            to_merge.push(path.to_string());
        }
    }

    // Filter by requested files if specified
    if !req.files.is_empty() {
        to_merge.retain(|f| req.files.iter().any(|rf| f == rf || f.starts_with(rf)));
    }

    to_merge.sort();

    let mut merged_files = Vec::new();
    let mut skipped_files = Vec::new();

    for file_path in &to_merge {
        // Apply merge strategy
        let target_exists = files_target.contains_key(file_path.as_str());
        if target_exists && matches!(req.strategy, MergeStrategy::Ours) {
            skipped_files.push(file_path.clone());
            continue;
        }

        // Read file from source (base64-encoded)
        let read_cmd = format!("base64 '{}'", file_path);
        let cmd = vec!["sh".into(), "-c".into(), read_cmd];
        let (exit_code, b64_content, _) =
            with_sandbox_client(&entry_source, move |c| {
                c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(30)))
            })
            .await?;

        if exit_code != 0 {
            tracing::warn!(file = %file_path, "failed to read file from source, skipping");
            skipped_files.push(file_path.clone());
            continue;
        }

        // Write file to target (base64-decode)
        let b64 = b64_content.trim().to_string();
        let write_cmd = format!(
            "mkdir -p '{}' && echo '{}' | base64 -d > '{}'",
            file_path.rsplit_once('/').map_or("", |(dir, _)| dir),
            b64,
            file_path,
        );
        let cmd = vec!["sh".into(), "-c".into(), write_cmd];
        let (exit_code, _, stderr) =
            with_sandbox_client(&entry_target, move |c| {
                c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(30)))
            })
            .await?;

        if exit_code != 0 {
            tracing::warn!(
                file = %file_path,
                stderr = %stderr,
                "failed to write file to target, skipping"
            );
            skipped_files.push(file_path.clone());
        } else {
            merged_files.push(file_path.clone());
        }
    }

    Ok(Json(MergeResponse {
        source: source_id,
        target: target_id,
        merged_files,
        skipped_files,
    }))
}

/// Debug mount information for a sandbox.
///
/// Returns configured mounts and guest-side mount state for diagnosing
/// virtiofs issues.
#[utoipa::path(
    get,
    path = "/api/v1/sandboxes/{id}/debug/mounts",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Sandbox name")
    ),
    responses(
        (status = 200, description = "Mount debug info", body = DebugMountsResponse),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Debug failed", body = ApiErrorResponse)
    )
)]
pub async fn debug_mounts(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
) -> Result<Json<DebugMountsResponse>, ApiError> {
    let entry = state.get_sandbox(&id)?;
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    let configured = {
        let lock = entry.lock();
        mounts_to_info(&lock.mounts)
    };

    // Guest-side mount output
    let (_, guest_mounts, _) = with_sandbox_client(&entry, |c| {
        c.vm_exec(
            vec!["mount".into()],
            vec![],
            None,
            Some(Duration::from_secs(10)),
        )
    })
    .await?;

    // Guest-side /mnt/ listing
    let (_, mnt_listing, _) = with_sandbox_client(&entry, |c| {
        c.vm_exec(
            vec!["sh".into(), "-c".into(), "ls -la /mnt/ 2>/dev/null || echo '(empty)'".into()],
            vec![],
            None,
            Some(Duration::from_secs(10)),
        )
    })
    .await?;

    // Check virtiofs support
    let (_, fs_output, _) = with_sandbox_client(&entry, |c| {
        c.vm_exec(
            vec!["sh".into(), "-c".into(), "cat /proc/filesystems 2>/dev/null | grep virtiofs || echo 'not found'".into()],
            vec![],
            None,
            Some(Duration::from_secs(10)),
        )
    })
    .await?;

    Ok(Json(DebugMountsResponse {
        configured,
        guest_mounts: guest_mounts.trim().to_string(),
        mnt_listing: mnt_listing.trim().to_string(),
        virtiofs_supported: fs_output.contains("virtiofs"),
    }))
}

/// Debug network information for a sandbox.
///
/// Returns configured ports and guest-side network state for diagnosing
/// port mapping issues.
#[utoipa::path(
    get,
    path = "/api/v1/sandboxes/{id}/debug/network",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Sandbox name")
    ),
    responses(
        (status = 200, description = "Network debug info", body = DebugNetworkResponse),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Debug failed", body = ApiErrorResponse)
    )
)]
pub async fn debug_network(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
) -> Result<Json<DebugNetworkResponse>, ApiError> {
    let entry = state.get_sandbox(&id)?;
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    let (configured_ports, network_enabled) = {
        let lock = entry.lock();
        (lock.ports.clone(), lock.network)
    };

    // Guest-side listening ports
    let (_, listening_ports, _) = with_sandbox_client(&entry, |c| {
        c.vm_exec(
            vec!["sh".into(), "-c".into(), "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo '(ss/netstat not available)'".into()],
            vec![],
            None,
            Some(Duration::from_secs(10)),
        )
    })
    .await?;

    // Guest-side network interfaces
    let (_, interfaces, _) = with_sandbox_client(&entry, |c| {
        c.vm_exec(
            vec!["sh".into(), "-c".into(), "ip addr 2>/dev/null || ifconfig 2>/dev/null || echo '(ip/ifconfig not available)'".into()],
            vec![],
            None,
            Some(Duration::from_secs(10)),
        )
    })
    .await?;

    Ok(Json(DebugNetworkResponse {
        configured_ports,
        listening_ports: listening_ports.trim().to_string(),
        interfaces: interfaces.trim().to_string(),
        network_enabled,
    }))
}

/// Get DNS filter status for a sandbox.
#[utoipa::path(
    get,
    path = "/api/v1/sandboxes/{id}/dns",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Sandbox name")
    ),
    responses(
        (status = 200, description = "DNS filter status", body = DnsFilterStatus),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse)
    )
)]
pub async fn dns_filter_status(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<DnsFilterStatus>, ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, SandboxRole::ReadOnly)?;
    }
    let entry = state.get_sandbox(&id)?;
    let lock = entry.lock();
    let (active, domains) = match &lock.allowed_domains {
        Some(d) if !d.is_empty() => (true, d.clone()),
        _ => (false, Vec::new()),
    };
    Ok(Json(DnsFilterStatus {
        active,
        allowed_domains: domains,
    }))
}
