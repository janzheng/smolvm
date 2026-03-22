//! Snapshot push/pull handlers.
//!
//! Provides endpoints for exporting sandbox state as compressed archives
//! (push) and importing them into new sandboxes (pull).

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use std::sync::Arc;
use tokio_util::io::ReaderStream;

use crate::agent::{vm_data_dir, AgentManager};
use crate::api::error::ApiError;
use crate::api::state::{ApiState, ReservationGuard, SandboxRegistration};
use crate::api::types::{
    ApiErrorResponse, ListSnapshotsResponse, PullSnapshotRequest, PushSnapshotRequest,
    PushSnapshotResponse, ResourceSpec, SandboxInfo, SnapshotManifest, UploadSnapshotQuery,
    UploadSnapshotResponse,
};
use crate::storage::{
    OverlayDisk, StorageDisk, OVERLAY_DISK_FILENAME, STORAGE_DISK_FILENAME,
};

/// Directory where snapshots are stored.
fn snapshots_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("smolvm")
        .join("snapshots")
}

/// Helper to exec a command in a running sandbox and return trimmed stdout.
/// Returns None if the sandbox is not running or the command fails.
async fn try_exec_in_sandbox(
    entry: &Arc<parking_lot::Mutex<crate::api::state::SandboxEntry>>,
    command: Vec<String>,
) -> Option<String> {
    use crate::api::state::with_sandbox_client;
    let result = with_sandbox_client(entry, move |c| {
        c.vm_exec_as(command, vec![], None, Some(std::time::Duration::from_secs(5)), None)
    })
    .await;
    match result {
        Ok((0, stdout, _)) => Some(stdout.trim().to_string()),
        _ => None,
    }
}

/// Push (export) a sandbox as a snapshot archive.
#[utoipa::path(
    post,
    path = "/api/v1/sandboxes/{id}/push",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Sandbox name to export")
    ),
    request_body(content = Option<PushSnapshotRequest>, description = "Optional push metadata"),
    responses(
        (status = 200, description = "Snapshot created", body = PushSnapshotResponse),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Export failed", body = ApiErrorResponse)
    )
)]
pub async fn push_sandbox(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    body: Option<Json<PushSnapshotRequest>>,
) -> Result<Json<PushSnapshotResponse>, ApiError> {
    let req = body.map(|b| b.0).unwrap_or_default();

    // Verify sandbox exists
    let entry = state.get_sandbox(&id)?;

    let network = {
        let lock = entry.lock();
        lock.network
    };

    // Get disk paths
    let data_dir = vm_data_dir(&id);
    let overlay_path = data_dir.join(OVERLAY_DISK_FILENAME);
    let storage_path = data_dir.join(STORAGE_DISK_FILENAME);

    if !overlay_path.exists() && !storage_path.exists() {
        return Err(ApiError::BadRequest(
            "sandbox has no disk state to export".into(),
        ));
    }

    // Flush filesystem caches so disk images are consistent for snapshot
    let _ = try_exec_in_sandbox(
        &entry,
        vec!["sync".into()],
    ).await;

    // Capture git info (best-effort — works only if sandbox is running with git workspace)
    let git_branch = try_exec_in_sandbox(
        &entry,
        vec!["sh".into(), "-c".into(), "git -C /storage/workspace rev-parse --abbrev-ref HEAD 2>/dev/null || git -C /workspace rev-parse --abbrev-ref HEAD 2>/dev/null".into()],
    ).await;
    let git_commit = try_exec_in_sandbox(
        &entry,
        vec!["sh".into(), "-c".into(), "git -C /storage/workspace rev-parse HEAD 2>/dev/null || git -C /workspace rev-parse HEAD 2>/dev/null".into()],
    ).await;
    let git_dirty = try_exec_in_sandbox(
        &entry,
        vec!["sh".into(), "-c".into(), "git -C /storage/workspace status --porcelain 2>/dev/null || git -C /workspace status --porcelain 2>/dev/null".into()],
    ).await.map(|s| !s.is_empty());

    // Read .smolvm_origin for automatic parent tracking
    let auto_parent = if req.parent_snapshot.is_none() {
        let origin_path = data_dir.join(".smolvm_origin");
        std::fs::read_to_string(&origin_path).ok().map(|s| s.trim().to_string())
    } else {
        None
    };

    // Create snapshots directory
    let snap_dir = snapshots_dir();
    std::fs::create_dir_all(&snap_dir)
        .map_err(|e| ApiError::Internal(format!("failed to create snapshots dir: {}", e)))?;

    let snapshot_name = id.clone();
    let archive_path = snap_dir.join(format!("{}.smolvm", snapshot_name));

    // Build manifest
    let overlay_size = if overlay_path.exists() {
        std::fs::metadata(&overlay_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    let storage_size = if storage_path.exists() {
        std::fs::metadata(&storage_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    let platform = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };

    let manifest = SnapshotManifest {
        name: snapshot_name.clone(),
        platform: format!("{}-{}", platform, os),
        network,
        created_at: chrono::Utc::now().to_rfc3339(),
        overlay_size_bytes: overlay_size,
        storage_size_bytes: storage_size,
        description: req.description,
        owner: None,
        parent_snapshot: req.parent_snapshot.or(auto_parent),
        git_branch,
        git_commit,
        git_dirty,
        sha256: None, // computed after archive creation
    };

    // Create tar.gz archive in a blocking task
    let manifest_clone = manifest.clone();
    let archive_path_clone = archive_path.clone();
    tokio::task::spawn_blocking(move || {
        use flate2::write::GzEncoder;
        use flate2::Compression;

        let file = std::fs::File::create(&archive_path_clone)
            .map_err(|e| ApiError::Internal(format!("failed to create archive: {}", e)))?;
        let enc = GzEncoder::new(file, Compression::fast());
        let mut tar = tar::Builder::new(enc);

        // Write manifest.json
        let manifest_json = serde_json::to_vec_pretty(&manifest_clone)
            .map_err(|e| ApiError::Internal(format!("failed to serialize manifest: {}", e)))?;
        let mut header = tar::Header::new_gnu();
        header.set_size(manifest_json.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, "manifest.json", &manifest_json[..])
            .map_err(|e| ApiError::Internal(format!("failed to write manifest to tar: {}", e)))?;

        // Write overlay disk if it exists
        if overlay_path.exists() {
            tar.append_path_with_name(&overlay_path, OVERLAY_DISK_FILENAME)
                .map_err(|e| {
                    ApiError::Internal(format!("failed to add overlay to archive: {}", e))
                })?;
        }

        // Write storage disk if it exists
        if storage_path.exists() {
            tar.append_path_with_name(&storage_path, STORAGE_DISK_FILENAME)
                .map_err(|e| {
                    ApiError::Internal(format!("failed to add storage to archive: {}", e))
                })?;
        }

        tar.into_inner()
            .map_err(|e| ApiError::Internal(format!("failed to finalize gz: {}", e)))?
            .finish()
            .map_err(|e| ApiError::Internal(format!("failed to finish gz: {}", e)))?;

        Ok::<(), ApiError>(())
    })
    .await
    .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    // Compute SHA-256 of the archive and write sidecar file
    let archive_path_for_hash = archive_path.clone();
    let sha256 = tokio::task::spawn_blocking(move || {
        use sha2::{Sha256, Digest};
        let mut file = std::fs::File::open(&archive_path_for_hash)
            .map_err(|e| ApiError::Internal(format!("failed to open archive for hashing: {}", e)))?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher)
            .map_err(|e| ApiError::Internal(format!("failed to hash archive: {}", e)))?;
        let hash = format!("{:x}", hasher.finalize());
        // Write sidecar .sha256 file
        let sidecar_path = format!("{}.sha256", archive_path_for_hash.display());
        let _ = std::fs::write(&sidecar_path, &hash);
        Ok::<String, ApiError>(hash)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    let mut final_manifest = manifest;
    final_manifest.sha256 = Some(sha256);

    Ok(Json(PushSnapshotResponse {
        name: snapshot_name,
        path: archive_path.display().to_string(),
        manifest: final_manifest,
    }))
}

/// List available snapshots.
#[utoipa::path(
    get,
    path = "/api/v1/snapshots",
    tag = "Sandboxes",
    responses(
        (status = 200, description = "List of snapshots", body = ListSnapshotsResponse)
    )
)]
pub async fn list_snapshots() -> Result<Json<ListSnapshotsResponse>, ApiError> {
    let snap_dir = snapshots_dir();
    if !snap_dir.exists() {
        return Ok(Json(ListSnapshotsResponse {
            snapshots: vec![],
        }));
    }

    let mut snapshots = Vec::new();

    let entries = std::fs::read_dir(&snap_dir)
        .map_err(|e| ApiError::Internal(format!("failed to read snapshots dir: {}", e)))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let filename = path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or_default();
        // Accept both new .smolvm and legacy .smolvm.tar.gz
        if !filename.ends_with(".smolvm") && !filename.ends_with(".smolvm.tar.gz") {
            continue;
        }

        // Try to read manifest from archive
        if let Ok(mut manifest) = read_manifest_from_archive(&path) {
            // Read SHA-256 from sidecar file if not already in manifest
            if manifest.sha256.is_none() {
                let sidecar = format!("{}.sha256", path.display());
                if let Ok(hash) = std::fs::read_to_string(&sidecar) {
                    manifest.sha256 = Some(hash.trim().to_string());
                }
            }
            snapshots.push(manifest);
        }
    }

    Ok(Json(ListSnapshotsResponse { snapshots }))
}

/// Pull (import) a snapshot into a new sandbox.
#[utoipa::path(
    post,
    path = "/api/v1/snapshots/{name}/pull",
    tag = "Sandboxes",
    params(
        ("name" = String, Path, description = "Snapshot name to import")
    ),
    request_body = PullSnapshotRequest,
    responses(
        (status = 200, description = "Sandbox created from snapshot", body = SandboxInfo),
        (status = 404, description = "Snapshot not found", body = ApiErrorResponse),
        (status = 409, description = "Sandbox name already exists", body = ApiErrorResponse),
        (status = 500, description = "Import failed", body = ApiErrorResponse)
    )
)]
pub async fn pull_snapshot(
    State(state): State<Arc<ApiState>>,
    Path(snapshot_name): Path<String>,
    Json(req): Json<PullSnapshotRequest>,
) -> Result<Json<SandboxInfo>, ApiError> {
    let archive_path = snapshots_dir().join(format!("{}.smolvm", snapshot_name));
    if !archive_path.exists() {
        return Err(ApiError::NotFound(format!(
            "snapshot '{}' not found",
            snapshot_name
        )));
    }

    // Reserve the sandbox name (RAII guard auto-releases on error)
    let guard = ReservationGuard::new(&state, req.name.clone())?;

    // Extract disks to new sandbox directory
    let target_dir = vm_data_dir(&req.name);
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| ApiError::Internal(format!("failed to create sandbox dir: {}", e)))?;

    let target_dir_clone = target_dir.clone();
    let manifest = tokio::task::spawn_blocking(move || {
        use flate2::read::GzDecoder;

        let file = std::fs::File::open(&archive_path)
            .map_err(|e| ApiError::Internal(format!("failed to open archive: {}", e)))?;
        let dec = GzDecoder::new(file);
        let mut tar = tar::Archive::new(dec);

        let mut manifest: Option<SnapshotManifest> = None;

        for entry in tar
            .entries()
            .map_err(|e| ApiError::Internal(format!("failed to read tar entries: {}", e)))?
        {
            let mut entry = entry
                .map_err(|e| ApiError::Internal(format!("failed to read tar entry: {}", e)))?;
            let path = entry
                .path()
                .map_err(|e| ApiError::Internal(format!("failed to read entry path: {}", e)))?
                .to_path_buf();

            let filename = path
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or_default();

            match filename {
                "manifest.json" => {
                    let mut contents = String::new();
                    std::io::Read::read_to_string(&mut entry, &mut contents).map_err(|e| {
                        ApiError::Internal(format!("failed to read manifest: {}", e))
                    })?;
                    manifest = Some(serde_json::from_str(&contents).map_err(|e| {
                        ApiError::Internal(format!("failed to parse manifest: {}", e))
                    })?);
                }
                name if name == OVERLAY_DISK_FILENAME => {
                    let dest = target_dir_clone.join(OVERLAY_DISK_FILENAME);
                    let mut out = std::fs::File::create(&dest).map_err(|e| {
                        ApiError::Internal(format!("failed to create overlay file: {}", e))
                    })?;
                    std::io::copy(&mut entry, &mut out).map_err(|e| {
                        ApiError::Internal(format!("failed to extract overlay: {}", e))
                    })?;
                }
                name if name == STORAGE_DISK_FILENAME => {
                    let dest = target_dir_clone.join(STORAGE_DISK_FILENAME);
                    let mut out = std::fs::File::create(&dest).map_err(|e| {
                        ApiError::Internal(format!("failed to create storage file: {}", e))
                    })?;
                    std::io::copy(&mut entry, &mut out).map_err(|e| {
                        ApiError::Internal(format!("failed to extract storage: {}", e))
                    })?;
                }
                _ => {}
            }
        }

        manifest.ok_or_else(|| {
            ApiError::Internal("archive missing manifest.json".into())
        })
    })
    .await
    .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    // Mark extracted disks as formatted so start() doesn't overwrite them with templates
    {
        let storage_marker = target_dir.join("storage.formatted");
        let overlay_marker = target_dir.join("overlay.formatted");
        let _ = std::fs::write(&storage_marker, "1");
        let _ = std::fs::write(&overlay_marker, "1");
        // Write origin marker for lineage tracking
        let origin_marker = target_dir.join(".smolvm_origin");
        let _ = std::fs::write(&origin_marker, &snapshot_name);
    }

    // Create AgentManager from the extracted disks (open_or_create_at opens existing files)
    let sandbox_name = req.name.clone();
    let overlay_size = manifest.overlay_size_bytes;
    let storage_size = manifest.storage_size_bytes;
    let manager_result = tokio::task::spawn_blocking(move || {
        let data_dir = vm_data_dir(&sandbox_name);
        let storage_path = data_dir.join(STORAGE_DISK_FILENAME);
        let overlay_path = data_dir.join(OVERLAY_DISK_FILENAME);

        // Convert bytes to GB for open_or_create_at (use at least defaults)
        let storage_gb = std::cmp::max(
            storage_size / (1024 * 1024 * 1024),
            crate::storage::DEFAULT_STORAGE_SIZE_GIB,
        );
        let overlay_gb = std::cmp::max(
            overlay_size / (1024 * 1024 * 1024),
            crate::storage::DEFAULT_OVERLAY_SIZE_GIB,
        );

        let storage_disk = StorageDisk::open_or_create_at(&storage_path, storage_gb)?;
        let overlay_disk = OverlayDisk::open_or_create_at(&overlay_path, overlay_gb)?;

        let rootfs_path = AgentManager::default_rootfs_path()?;
        AgentManager::new_named(&sandbox_name, rootfs_path, storage_disk, overlay_disk)
    })
    .await;

    let manager = match manager_result {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => return Err(ApiError::internal(e)),
        Err(e) => return Err(ApiError::internal(e)),
    };

    let agent_state = manager.state().to_string();
    let pid = manager.child_pid();
    let network = manifest.network;

    // Register the sandbox with the server
    let resources = ResourceSpec::default();
    guard.complete(SandboxRegistration {
        manager,
        mounts: vec![],
        ports: vec![],
        resources: resources.clone(),
        restart: crate::config::RestartConfig::default(),
        network,
        allowed_domains: None,
        secrets: vec![],
        default_env: vec![],
        owner_token_hash: None,
        mcp_servers: vec![],
    })?;

    Ok(Json(SandboxInfo {
        name: req.name,
        state: agent_state,
        pid,
        mounts: vec![],
        ports: vec![],
        resources,
        network,
        restart_count: None,
    }))
}

/// Delete a snapshot.
#[utoipa::path(
    delete,
    path = "/api/v1/snapshots/{name}",
    tag = "Sandboxes",
    params(
        ("name" = String, Path, description = "Snapshot name to delete")
    ),
    responses(
        (status = 200, description = "Snapshot deleted"),
        (status = 404, description = "Snapshot not found", body = ApiErrorResponse)
    )
)]
pub async fn delete_snapshot(
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let archive_path = snapshots_dir().join(format!("{}.smolvm", name));
    if !archive_path.exists() {
        return Err(ApiError::NotFound(format!(
            "snapshot '{}' not found",
            name
        )));
    }

    std::fs::remove_file(&archive_path)
        .map_err(|e| ApiError::Internal(format!("failed to delete snapshot: {}", e)))?;

    // Clean up sidecar .sha256 file if it exists
    let sidecar_path = snapshots_dir().join(format!("{}.smolvm.sha256", name));
    let _ = std::fs::remove_file(&sidecar_path);

    Ok(Json(serde_json::json!({ "deleted": name })))
}

/// Download a snapshot archive as a streaming binary file.
#[utoipa::path(
    get,
    path = "/api/v1/snapshots/{name}/download",
    tag = "Sandboxes",
    params(
        ("name" = String, Path, description = "Snapshot name to download")
    ),
    responses(
        (status = 200, description = "Snapshot archive stream", content_type = "application/octet-stream"),
        (status = 404, description = "Snapshot not found", body = ApiErrorResponse)
    )
)]
pub async fn download_snapshot(
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let archive_path = snapshots_dir().join(format!("{}.smolvm", name));
    if !archive_path.exists() {
        return Err(ApiError::NotFound(format!(
            "snapshot '{}' not found",
            name
        )));
    }

    // Get file metadata for Content-Length
    let metadata = tokio::fs::metadata(&archive_path)
        .await
        .map_err(|e| ApiError::Internal(format!("failed to read file metadata: {}", e)))?;
    let file_size = metadata.len();

    // Open file for streaming
    let file = tokio::fs::File::open(&archive_path)
        .await
        .map_err(|e| ApiError::Internal(format!("failed to open snapshot file: {}", e)))?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    // Build response headers
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{}.smolvm\"", name)
            .parse()
            .unwrap(),
    );
    headers.insert(header::CONTENT_LENGTH, file_size.into());

    // Include SHA-256 from sidecar if available
    let sidecar_path = snapshots_dir().join(format!("{}.smolvm.sha256", name));
    if let Ok(hash) = tokio::fs::read_to_string(&sidecar_path).await {
        if let Ok(val) = hash.trim().parse() {
            headers.insert("x-smolvm-sha256", val);
        }
    }

    Ok((StatusCode::OK, headers, body))
}

/// Upload a snapshot archive from streaming binary body.
#[utoipa::path(
    post,
    path = "/api/v1/snapshots/upload",
    tag = "Sandboxes",
    params(
        ("name" = String, Query, description = "Name for the uploaded snapshot")
    ),
    request_body(content_type = "application/octet-stream", description = "Raw .smolvm archive bytes"),
    responses(
        (status = 200, description = "Snapshot uploaded successfully", body = UploadSnapshotResponse),
        (status = 400, description = "Invalid archive or checksum mismatch", body = ApiErrorResponse),
        (status = 500, description = "Upload failed", body = ApiErrorResponse)
    )
)]
pub async fn upload_snapshot(
    Query(query): Query<UploadSnapshotQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<UploadSnapshotResponse>, ApiError> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let name = query.name;
    let snap_dir = snapshots_dir();
    std::fs::create_dir_all(&snap_dir)
        .map_err(|e| ApiError::Internal(format!("failed to create snapshots dir: {}", e)))?;

    // Stream body to a temp file, then rename atomically
    let temp_path = snap_dir.join(format!(".{}.smolvm.tmp", name));
    let final_path = snap_dir.join(format!("{}.smolvm", name));

    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| ApiError::Internal(format!("failed to create temp file: {}", e)))?;

    let mut hasher = Sha256::new();
    let mut total_bytes: u64 = 0;
    let mut stream = body.into_data_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ApiError::Internal(format!("failed to read body chunk: {}", e)))?;
        hasher.update(&chunk);
        total_bytes += chunk.len() as u64;
        file.write_all(&chunk)
            .await
            .map_err(|e| ApiError::Internal(format!("failed to write chunk: {}", e)))?;
    }

    file.flush()
        .await
        .map_err(|e| ApiError::Internal(format!("failed to flush file: {}", e)))?;
    drop(file);

    let computed_sha256 = format!("{:x}", hasher.finalize());

    // Validate checksum if client provided one
    if let Some(expected) = headers.get("x-smolvm-sha256").and_then(|v| v.to_str().ok()) {
        if expected.trim() != computed_sha256 {
            // Clean up temp file
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(ApiError::BadRequest(format!(
                "SHA-256 mismatch: expected {}, got {}",
                expected.trim(),
                computed_sha256
            )));
        }
    }

    // Rename temp file to final location
    tokio::fs::rename(&temp_path, &final_path)
        .await
        .map_err(|e| ApiError::Internal(format!("failed to rename snapshot file: {}", e)))?;

    // Read manifest from the archive
    let final_path_clone = final_path.clone();
    let manifest = tokio::task::spawn_blocking(move || read_manifest_from_archive(&final_path_clone))
        .await
        .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    // Write SHA-256 sidecar file
    let sidecar_path = snap_dir.join(format!("{}.smolvm.sha256", name));
    let _ = tokio::fs::write(&sidecar_path, &computed_sha256).await;

    Ok(Json(UploadSnapshotResponse {
        name,
        size_bytes: total_bytes,
        manifest,
    }))
}

/// Read a manifest from a .smolvm archive.
fn read_manifest_from_archive(path: &std::path::Path) -> Result<SnapshotManifest, ApiError> {
    use flate2::read::GzDecoder;

    let file = std::fs::File::open(path)
        .map_err(|e| ApiError::Internal(format!("failed to open archive: {}", e)))?;
    let dec = GzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);

    for entry in tar
        .entries()
        .map_err(|e| ApiError::Internal(format!("failed to read tar: {}", e)))?
    {
        let mut entry =
            entry.map_err(|e| ApiError::Internal(format!("failed to read entry: {}", e)))?;
        let path = entry
            .path()
            .map_err(|e| ApiError::Internal(format!("path error: {}", e)))?
            .to_path_buf();
        if path.file_name().and_then(|f| f.to_str()) == Some("manifest.json") {
            let mut contents = String::new();
            std::io::Read::read_to_string(&mut entry, &mut contents)
                .map_err(|e| ApiError::Internal(format!("failed to read manifest: {}", e)))?;
            return serde_json::from_str(&contents)
                .map_err(|e| ApiError::Internal(format!("failed to parse manifest: {}", e)));
        }
    }

    Err(ApiError::Internal("no manifest.json in archive".into()))
}
