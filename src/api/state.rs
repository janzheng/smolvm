//! API server state management.

use crate::agent::{AgentManager, HostMount, PortMapping, VmResources};
use crate::api::error::ApiError;
use crate::api::types::{ExecResponse, JobInfo, JobStatus, McpServerConfig, MountSpec, PortSpec, ResourceSpec, RestartSpec, MachineInfo, MachinePermission, MachineRole};
use crate::config::{RecordState, RestartConfig, RestartPolicy, VmRecord};
use crate::data::resources::{DEFAULT_MICROVM_CPU_COUNT, DEFAULT_MICROVM_MEMORY_MIB};
use crate::db::SmolvmDb;
use crate::proxy::{ProxyConfig, SecretService};
use metrics_exporter_prometheus::PrometheusHandle;
use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

/// Shared API server state.
pub struct ApiState {
    /// Registry of machine managers by name.
    machines: RwLock<HashMap<String, Arc<parking_lot::Mutex<MachineEntry>>>>,
    /// Reserved machine names (creation in progress).
    /// This prevents race conditions during machine creation.
    reserved_names: RwLock<HashSet<String>>,
    /// Database for persistent state.
    db: SmolvmDb,
    /// Prometheus metrics handle for rendering /metrics endpoint.
    pub metrics_handle: PrometheusHandle,
    /// Secret proxy configuration (None if no secrets configured).
    /// Wrapped in RwLock to allow hot-reloading secrets at runtime.
    pub proxy_config: RwLock<Option<ProxyConfig>>,
    /// Registry of all known service definitions (built-in + custom).
    /// Used when building per-machine proxy configs and for the services API.
    service_registry: RwLock<HashMap<String, SecretService>>,
    /// In-memory work queue for job dispatch.
    jobs: RwLock<Vec<JobInfo>>,
}

/// Internal machine entry with manager and configuration.
pub struct MachineEntry {
    /// The agent manager for this machine.
    /// Wrapped in Arc so it can be used without holding the MachineEntry lock
    /// (AgentManager has its own internal locking via Arc<Mutex<AgentInner>>).
    pub manager: Arc<AgentManager>,
    /// Host mounts configured for this machine.
    pub mounts: Vec<MountSpec>,
    /// Port mappings configured for this machine.
    pub ports: Vec<PortSpec>,
    /// VM resources configured for this machine.
    pub resources: ResourceSpec,
    /// Restart configuration for this machine.
    pub restart: RestartConfig,
    /// Whether outbound network access is enabled.
    pub network: bool,
    /// Allowed domains for egress filtering (None = no filtering).
    pub allowed_domains: Option<Vec<String>>,
    /// Secret names enabled for this machine (e.g., ["anthropic", "openai"]).
    pub secrets: Vec<String>,
    /// Default env vars to inject into every exec call (e.g., BASE_URL overrides).
    pub default_env: Vec<(String, String)>,
    /// Hash of the token that created this machine (Owner).
    pub owner_token_hash: Option<String>,
    /// Additional permission grants for this machine.
    pub permissions: Vec<MachinePermission>,
    /// MCP server configurations for this machine.
    pub mcp_servers: Vec<McpServerConfig>,
}

/// Parameters for registering a new machine.
pub struct MachineRegistration {
    /// The agent manager for this machine.
    pub manager: AgentManager,
    /// Host mounts to configure.
    pub mounts: Vec<MountSpec>,
    /// Port mappings to configure.
    pub ports: Vec<PortSpec>,
    /// VM resources to configure.
    pub resources: ResourceSpec,
    /// Restart configuration.
    pub restart: RestartConfig,
    /// Whether outbound network access is enabled.
    pub network: bool,
    /// Allowed domains for egress filtering (None = no filtering).
    pub allowed_domains: Option<Vec<String>>,
    /// Secret names enabled for this machine.
    pub secrets: Vec<String>,
    /// Default env vars to inject into every exec call.
    pub default_env: Vec<(String, String)>,
    /// Hash of the token that created this machine (Owner).
    pub owner_token_hash: Option<String>,
    /// MCP server configurations for this machine.
    pub mcp_servers: Vec<McpServerConfig>,
}

/// RAII guard for machine name reservation.
///
/// Automatically releases reservation on drop unless consumed by `complete()`.
/// This ensures reservations are always cleaned up, even on panic.
///
/// # Example
///
/// ```ignore
/// let guard = ReservationGuard::new(&state, "my-machine".to_string())?;
///
/// // Create the machine manager...
/// let manager = AgentManager::for_vm(guard.name())?;
///
/// // Complete registration, consuming the guard
/// guard.complete(MachineRegistration { manager, mounts, ports, resources, restart, network })?;
/// ```
pub struct ReservationGuard<'a> {
    state: &'a ApiState,
    name: String,
    completed: bool,
}

impl<'a> ReservationGuard<'a> {
    /// Reserve a machine name. Returns a guard that auto-releases on drop.
    pub fn new(state: &'a ApiState, name: String) -> Result<Self, ApiError> {
        state.reserve_machine_name(&name)?;
        Ok(Self {
            state,
            name,
            completed: false,
        })
    }

    /// Get the reserved name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Complete registration, consuming the guard without releasing.
    ///
    /// This transfers ownership of the name to the machine registry.
    pub fn complete(mut self, registration: MachineRegistration) -> Result<(), ApiError> {
        // Mark as completed before calling complete_machine_registration
        // (which will remove from reservations internally)
        self.completed = true;
        self.state
            .complete_machine_registration(self.name.clone(), registration)
    }
}

impl Drop for ReservationGuard<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.state.release_machine_reservation(&self.name);
            tracing::debug!(machine = %self.name, "reservation guard released on drop");
        }
    }
}

impl ApiState {
    /// Create a new API state, opening the database.
    ///
    /// Returns an error if the database cannot be opened.
    pub fn new() -> Result<Self, ApiError> {
        let db = SmolvmDb::open()
            .map_err(|e| ApiError::internal(format!("failed to open database: {}", e)))?;
        // Ensure tables exist at server startup (CLI paths handle this lazily).
        db.init_tables().map_err(|e| {
            ApiError::internal(format!("failed to initialize database tables: {}", e))
        })?;
        let metrics_handle = crate::api::metrics::init();
        Ok(Self {
            machines: RwLock::new(HashMap::new()),
            reserved_names: RwLock::new(HashSet::new()),
            db,
            metrics_handle,
            proxy_config: RwLock::new(None),
            service_registry: RwLock::new(crate::proxy::services::builtin_services()),
            jobs: RwLock::new(Vec::new()),
        })
    }

    /// Create a new API state with a specific database.
    ///
    /// Useful for testing with temporary databases.
    pub fn with_db(db: SmolvmDb) -> Self {
        let metrics_handle = crate::api::metrics::init();
        Self {
            machines: RwLock::new(HashMap::new()),
            reserved_names: RwLock::new(HashSet::new()),
            db,
            metrics_handle,
            proxy_config: RwLock::new(None),
            service_registry: RwLock::new(crate::proxy::services::builtin_services()),
            jobs: RwLock::new(Vec::new()),
        }
    }

    /// Set the proxy configuration for secret injection.
    pub fn set_proxy_config(&mut self, config: ProxyConfig) {
        *self.proxy_config.write() = Some(config);
    }

    /// Replace the service registry (e.g., after loading from config file).
    pub fn set_service_registry(&mut self, services: HashMap<String, SecretService>) {
        *self.service_registry.write() = services;
    }

    /// List all registered service definitions (no secrets exposed).
    pub fn list_services(&self) -> Vec<crate::api::types::ServiceInfo> {
        let registry = self.service_registry.read();
        let mut services: Vec<_> = registry
            .values()
            .map(|svc| crate::api::types::ServiceInfo {
                name: svc.name.clone(),
                base_url: svc.base_url.clone(),
                auth_header: svc.auth_header.clone(),
                auth_prefix: svc.auth_prefix.clone(),
                env_key_name: svc.env_key_name.clone(),
                env_url_name: svc.env_url_name.clone(),
            })
            .collect();
        services.sort_by(|a, b| a.name.cmp(&b.name));
        services
    }

    /// Register a new service definition at runtime.
    pub fn register_service(&self, service: SecretService) {
        let mut registry = self.service_registry.write();
        registry.insert(service.name.clone(), service);
    }

    /// Get the current service registry (for building per-machine proxy configs).
    pub fn get_service_registry(&self) -> HashMap<String, SecretService> {
        self.service_registry.read().clone()
    }

    /// Update secrets in the proxy configuration at runtime (hot-reload).
    ///
    /// Merges the provided secrets into the existing ProxyConfig, updating
    /// existing keys and adding new ones. Returns the list of updated secret names.
    ///
    /// Returns `None` if no proxy config exists (server started without --secrets).
    pub fn update_secrets(&self, new_secrets: HashMap<String, String>) -> Option<Vec<String>> {
        let mut config_guard = self.proxy_config.write();
        let config = config_guard.as_mut()?;
        let updated: Vec<String> = new_secrets.keys().cloned().collect();
        for (name, value) in new_secrets {
            config.secrets.insert(name, value);
        }
        // Rebuild services to include any newly-added secret names
        let all_services = crate::proxy::services::builtin_services();
        config.services = all_services
            .into_iter()
            .filter(|(name, _)| config.secrets.contains_key(name))
            .map(|(name, svc)| (name.to_string(), svc))
            .collect();
        Some(updated)
    }

    /// Get the list of configured secret names (not values) and service names.
    ///
    /// Returns `None` if no proxy config exists.
    pub fn list_secret_names(&self) -> Option<(Vec<String>, Vec<String>)> {
        let config_guard = self.proxy_config.read();
        let config = config_guard.as_ref()?;
        let secrets: Vec<String> = config.secrets.keys().cloned().collect();
        let services: Vec<String> = config.services.keys().cloned().collect();
        Some((secrets, services))
    }

    /// Load existing machines from persistent database.
    /// Call this on server startup to reconnect to running VMs.
    pub fn load_persisted_machines(&self) -> Vec<String> {
        let vms = match self.db.list_vms() {
            Ok(vms) => vms,
            Err(e) => {
                tracing::warn!(error = %e, "failed to load VMs from database");
                return Vec::new();
            }
        };

        let mut loaded = Vec::new();

        for (name, record) in vms {
            // Check if VM process is still alive
            if !record.is_process_alive() {
                tracing::info!(machine = %name, "cleaning up dead machine from database");
                if let Err(e) = self.db.remove_vm(&name) {
                    tracing::warn!(machine = %name, error = %e, "failed to remove dead machine from database");
                }
                continue;
            }

            // Convert VmRecord to MachineEntry
            let mounts: Vec<MountSpec> = record
                .mounts
                .iter()
                .map(|(source, target, readonly)| MountSpec {
                    source: source.clone(),
                    target: target.clone(),
                    readonly: *readonly,
                })
                .collect();

            let ports: Vec<PortSpec> = record
                .ports
                .iter()
                .map(|(host, guest)| PortSpec {
                    host: *host,
                    guest: *guest,
                })
                .collect();

            let resources = ResourceSpec {
                cpus: Some(record.cpus),
                memory_mb: Some(record.mem),
                network: Some(record.network),
                storage_gb: record.storage_gb,
                overlay_gb: record.overlay_gb,
                allowed_domains: record.allowed_domains.clone(),
                allowed_cidrs: record.allowed_cidrs.clone(),
            };

            // Create AgentManager and try to reconnect
            match AgentManager::for_vm_with_sizes(&name, record.storage_gb, record.overlay_gb) {
                Ok(manager) => {
                    // Try to reconnect to existing running VM
                    let reconnected = manager
                        .try_connect_existing_with_pid_and_start_time(
                            record.pid,
                            record.pid_start_time,
                        )
                        .is_some();

                    if reconnected {
                        tracing::info!(machine = %name, pid = ?record.pid, "reconnected to machine");
                    } else {
                        // Process is alive but agent isn't reachable yet (transient
                        // boot/socket timing). Register the machine anyway so it's
                        // visible via APIs and the supervisor can manage it. Keep
                        // the DB record for future reconnect attempts.
                        tracing::info!(machine = %name, pid = ?record.pid, "machine alive but not yet reachable, registering for later reconnect");
                    }

                    let mut machines = self.machines.write();
                    machines.insert(
                        name.clone(),
                        Arc::new(parking_lot::Mutex::new(MachineEntry {
                            manager: Arc::new(manager),
                            mounts,
                            ports,
                            resources,
                            restart: record.restart.clone(),
                            network: record.network,
                            allowed_domains: record.allowed_domains.clone(),
                            secrets: record.secrets.clone(),
                            default_env: Vec::new(),
                            owner_token_hash: record.owner_token_hash.clone(),
                            permissions: record.owner_token_hash.as_ref().map(|h| {
                                vec![MachinePermission {
                                    token_hash: h.clone(),
                                    role: MachineRole::Owner,
                                }]
                            }).unwrap_or_default(),
                            mcp_servers: record.mcp_servers.clone(),
                        })),
                    );
                    loaded.push(name.clone());
                }
                Err(e) => {
                    // Process is alive but manager creation failed (transient
                    // filesystem/env issue). Preserve the DB record so the VM
                    // isn't orphaned — next server restart can retry.
                    tracing::warn!(machine = %name, error = %e, "failed to create manager for alive machine, preserving DB record");
                }
            }
        }

        loaded
    }

    /// Get a machine entry by name.
    pub fn get_machine(
        &self,
        name: &str,
    ) -> Result<Arc<parking_lot::Mutex<MachineEntry>>, ApiError> {
        let machines = self.machines.read();
        machines
            .get(name)
            .cloned()
            .ok_or_else(|| ApiError::NotFound(format!("machine '{}' not found", name)))
    }

    /// Remove a machine from the registry (also removes from database).
    pub fn remove_machine(
        &self,
        name: &str,
    ) -> Result<Arc<parking_lot::Mutex<MachineEntry>>, ApiError> {
        // Quick existence check with read lock (fast path for 404).
        if !self.machines.read().contains_key(name) {
            return Err(ApiError::NotFound(format!("machine '{}' not found", name)));
        }

        // Remove from database BEFORE taking the write lock.
        // This keeps the write lock scope minimal (microseconds vs milliseconds).
        // Safe: if DB remove fails we return error and in-memory state is untouched.
        match self.db.remove_vm(name) {
            Ok(Some(_)) => {} // expected: row existed and was deleted
            Ok(None) => {
                tracing::warn!(
                    machine = name,
                    "machine not found in database during remove (already deleted?)"
                );
            }
            Err(e) => {
                tracing::error!(error = %e, machine = name, "failed to remove machine from database");
                return Err(ApiError::Internal(format!("database error: {}", e)));
            }
        }

        // Brief write lock for in-memory removal only.
        let mut machines = self.machines.write();
        match machines.remove(name) {
            Some(entry) => Ok(entry),
            None => {
                // Concurrent delete already removed it
                Err(ApiError::NotFound(format!("machine '{}' not found", name)))
            }
        }
    }

    /// Update machine state in database (call after start/stop).
    ///
    /// Returns an error if the database write fails. Callers in API handlers
    /// should propagate this error; the supervisor can log and continue.
    pub fn update_machine_state(
        &self,
        name: &str,
        state: RecordState,
        pid: Option<i32>,
    ) -> std::result::Result<(), crate::Error> {
        let pid_start_time = pid.and_then(crate::process::process_start_time);
        let result = self.db.update_vm(name, |record| {
            record.state = state;
            record.pid = pid;
            record.pid_start_time = pid_start_time;
        })?;
        match result {
            Some(_) => Ok(()),
            None => Err(crate::Error::database(
                "update machine state",
                format!("machine '{}' not found in database", name),
            )),
        }
    }

    /// List all machines.
    pub fn list_machines(&self) -> Vec<MachineInfo> {
        let machines = self.machines.read();
        machines
            .iter()
            .map(|(name, entry)| {
                let entry = entry.lock();
                crate::api::handlers::machines::machine_entry_to_info(name.clone(), &entry)
            })
            .collect()
    }

    /// Check if a machine exists.
    pub fn machine_exists(&self, name: &str) -> bool {
        self.machines.read().contains_key(name)
    }

    // ========================================================================
    // Atomic Machine Creation (Reservation Pattern)
    // ========================================================================

    /// Reserve a machine name atomically.
    ///
    /// This prevents race conditions where two concurrent requests try to create
    /// a machine with the same name. The name is reserved until either:
    /// - `complete_machine_registration()` is called (success)
    /// - `release_machine_reservation()` is called (failure/cleanup)
    ///
    /// Returns `Err(Conflict)` if the name is already taken or reserved.
    pub fn reserve_machine_name(&self, name: &str) -> Result<(), ApiError> {
        // Fast-path checks without holding the write lock.
        if self.machines.read().contains_key(name) {
            return Err(ApiError::Conflict(format!(
                "machine '{}' already exists",
                name
            )));
        }

        if self.reserved_names.read().contains(name) {
            return Err(ApiError::Conflict(format!(
                "machine '{}' is being created by another request",
                name
            )));
        }

        // Check database without holding any locks.
        if let Ok(Some(_)) = self.db.get_vm(name) {
            return Err(ApiError::Conflict(format!(
                "machine '{}' already exists in database",
                name
            )));
        }

        // Now acquire write lock and re-check atomically before inserting.
        let mut reserved = self.reserved_names.write();
        if reserved.contains(name) {
            return Err(ApiError::Conflict(format!(
                "machine '{}' is being created by another request",
                name
            )));
        }
        if self.machines.read().contains_key(name) {
            return Err(ApiError::Conflict(format!(
                "machine '{}' already exists",
                name
            )));
        }

        reserved.insert(name.to_string());
        tracing::debug!(machine = %name, "reserved machine name");
        Ok(())
    }

    /// Release a machine name reservation.
    ///
    /// Call this if machine creation fails after `reserve_machine_name()`.
    pub fn release_machine_reservation(&self, name: &str) {
        let mut reserved = self.reserved_names.write();
        if reserved.remove(name) {
            tracing::debug!(machine = %name, "released machine name reservation");
        }
    }

    /// Complete machine registration after successful creation.
    ///
    /// This converts a reserved name into a fully registered machine.
    /// The reservation is released and the machine entry is added.
    pub fn complete_machine_registration(
        &self,
        name: String,
        reg: MachineRegistration,
    ) -> Result<(), ApiError> {
        // Remove from reservations
        {
            let mut reserved = self.reserved_names.write();
            if !reserved.remove(&name) {
                // Name wasn't reserved - this is a programming error
                tracing::warn!(machine = %name, "completing registration for non-reserved name");
            }
        }

        // Persist to database (with conflict detection)
        let mut record = VmRecord::new_with_restart(
            name.clone(),
            reg.resources.cpus.unwrap_or(DEFAULT_MICROVM_CPU_COUNT),
            reg.resources
                .memory_mb
                .unwrap_or(DEFAULT_MICROVM_MEMORY_MIB),
            reg.mounts
                .iter()
                .map(|m| (m.source.clone(), m.target.clone(), m.readonly))
                .collect(),
            reg.ports.iter().map(|p| (p.host, p.guest)).collect(),
            reg.network,
            reg.restart.clone(),
        );
        record.storage_gb = reg.resources.storage_gb;
        record.overlay_gb = reg.resources.overlay_gb;
        record.allowed_cidrs = reg.resources.allowed_cidrs.clone();
        record.allowed_domains = reg.allowed_domains.clone();
        record.secrets = reg.secrets.clone();
        record.mcp_servers = reg.mcp_servers.clone();
        record.owner_token_hash = reg.owner_token_hash.clone();

        // Use insert_vm_if_not_exists for atomic database insert
        match self.db.insert_vm_if_not_exists(&name, &record) {
            Ok(true) => {
                // Successfully inserted, now add to in-memory registry
                let mut machines = self.machines.write();
                machines.insert(
                    name,
                    Arc::new(parking_lot::Mutex::new(MachineEntry {
                        manager: Arc::new(reg.manager),
                        mounts: reg.mounts,
                        ports: reg.ports,
                        resources: reg.resources,
                        restart: reg.restart,
                        network: reg.network,
                        allowed_domains: reg.allowed_domains,
                        secrets: reg.secrets,
                        default_env: reg.default_env,
                        owner_token_hash: reg.owner_token_hash.clone(),
                        permissions: reg.owner_token_hash.map(|h| {
                            vec![MachinePermission {
                                token_hash: h,
                                role: MachineRole::Owner,
                            }]
                        }).unwrap_or_default(),
                        mcp_servers: reg.mcp_servers,
                    })),
                );
                Ok(())
            }
            Ok(false) => {
                // Name already exists in database (shouldn't happen with reservation)
                Err(ApiError::Conflict(format!(
                    "machine '{}' already exists in database",
                    name
                )))
            }
            Err(e) => {
                tracing::error!(error = %e, machine = %name, "database error during registration");
                Err(ApiError::database(e))
            }
        }
    }

    /// Get the underlying database handle.
    pub fn db(&self) -> &SmolvmDb {
        &self.db
    }

    // ========================================================================
    // Restart Management Methods
    // ========================================================================

    /// List all machine names.
    pub fn list_machine_names(&self) -> Vec<String> {
        self.machines.read().keys().cloned().collect()
    }

    /// Get restart config for a machine from the in-memory registry.
    pub fn get_restart_config(&self, name: &str) -> Option<RestartConfig> {
        let machines = self.machines.read();
        machines.get(name).map(|entry| {
            let entry = entry.lock();
            entry.restart.clone()
        })
    }

    /// Best-effort update to the VM database record. Logs warnings on
    /// `Ok(None)` (row not found) and `Err` without propagating.
    fn update_vm_best_effort(&self, name: &str, op_label: &str, f: impl FnOnce(&mut VmRecord)) {
        match self.db.update_vm(name, f) {
            Ok(Some(_)) => {}
            Ok(None) => {
                tracing::warn!(machine = %name, op = op_label, "machine not found in database");
            }
            Err(e) => {
                tracing::warn!(error = %e, machine = %name, op = op_label, "failed to persist update");
            }
        }
    }

    /// Increment restart count for a machine.
    pub fn increment_restart_count(&self, name: &str) {
        if let Some(entry) = self.machines.read().get(name) {
            entry.lock().restart.restart_count += 1;
        }
        self.update_vm_best_effort(name, "increment_restart_count", |r| {
            r.restart.restart_count += 1;
        });
    }

    /// Mark machine as user-stopped.
    pub fn mark_user_stopped(&self, name: &str, stopped: bool) {
        if let Some(entry) = self.machines.read().get(name) {
            entry.lock().restart.user_stopped = stopped;
        }
        self.update_vm_best_effort(name, "mark_user_stopped", |r| {
            r.restart.user_stopped = stopped;
        });
    }

    /// Reset restart count (on successful start).
    pub fn reset_restart_count(&self, name: &str) {
        if let Some(entry) = self.machines.read().get(name) {
            entry.lock().restart.restart_count = 0;
        }
        self.update_vm_best_effort(name, "reset_restart_count", |r| {
            r.restart.restart_count = 0;
        });
    }

    /// Update last exit code for a machine.
    pub fn set_last_exit_code(&self, name: &str, exit_code: Option<i32>) {
        self.update_vm_best_effort(name, "set_last_exit_code", |r| {
            r.last_exit_code = exit_code;
        });
    }

    /// Get last exit code for a machine.
    pub fn get_last_exit_code(&self, name: &str) -> Option<i32> {
        self.db
            .get_vm(name)
            .ok()
            .flatten()
            .and_then(|r| r.last_exit_code)
    }

    /// Check if a machine process is alive.
    ///
    /// Delegates to `AgentManager::is_process_alive()` which checks the
    /// in-memory child handle (with stored start time) and falls back to the
    /// PID file. This is start-time-aware to avoid false positives from PID
    /// reuse, and covers orphan processes not tracked in-memory.
    pub fn is_machine_alive(&self, name: &str) -> bool {
        if let Some(entry) = self.machines.read().get(name) {
            let entry = entry.lock();
            entry.manager.is_process_alive()
        } else {
            false
        }
    }

    // ── Work Queue / Job Management ──────────────────────────────────

    /// Add a job to the work queue.
    pub fn add_job(&self, job: JobInfo) {
        self.jobs.write().push(job);
    }

    /// List jobs with optional filters.
    pub fn list_jobs(
        &self,
        status: Option<&str>,
        machine: Option<&str>,
        limit: Option<usize>,
    ) -> Vec<JobInfo> {
        let jobs = self.jobs.read();
        let iter = jobs.iter().filter(|j| {
            if let Some(s) = status {
                let job_status = format!("{:?}", j.status).to_lowercase();
                if job_status != s.to_lowercase() {
                    return false;
                }
            }
            if let Some(sb) = machine {
                if j.machine != sb {
                    return false;
                }
            }
            true
        });
        match limit {
            Some(n) => iter.take(n).cloned().collect(),
            None => iter.cloned().collect(),
        }
    }

    /// Get a job by ID.
    pub fn get_job(&self, id: &str) -> Option<JobInfo> {
        self.jobs.read().iter().find(|j| j.id == id).cloned()
    }

    /// Atomically claim the highest-priority queued job, transitioning it to running.
    pub fn poll_next_job(&self) -> Option<JobInfo> {
        let mut jobs = self.jobs.write();
        // Find the highest-priority queued job (higher priority value = higher priority)
        let idx = jobs
            .iter()
            .enumerate()
            .filter(|(_, j)| matches!(j.status, JobStatus::Queued))
            .max_by_key(|(_, j)| j.priority)
            .map(|(i, _)| i);

        if let Some(i) = idx {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            jobs[i].status = JobStatus::Running;
            jobs[i].started_at = Some(now);
            jobs[i].attempts += 1;
            Some(jobs[i].clone())
        } else {
            None
        }
    }

    /// Mark a job as completed with its result.
    pub fn complete_job(&self, id: &str, result: ExecResponse) -> Option<JobInfo> {
        let mut jobs = self.jobs.write();
        if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            job.status = JobStatus::Completed;
            job.completed_at = Some(now);
            job.result = Some(result);
            Some(job.clone())
        } else {
            None
        }
    }

    /// Mark a job as failed. If retries remain, re-queue it; otherwise mark as dead.
    pub fn fail_job(&self, id: &str, error: &str) -> Option<JobInfo> {
        let mut jobs = self.jobs.write();
        if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            job.error = Some(error.to_string());
            if job.attempts < job.max_retries + 1 {
                // Re-queue for retry
                job.status = JobStatus::Queued;
                job.started_at = None;
            } else {
                // No retries left — mark as dead
                job.status = JobStatus::Dead;
                job.completed_at = Some(now);
            }
            Some(job.clone())
        } else {
            None
        }
    }

    /// Remove a job from the queue. Returns true if found and removed.
    pub fn remove_job(&self, id: &str) -> bool {
        let mut jobs = self.jobs.write();
        let len_before = jobs.len();
        jobs.retain(|j| j.id != id);
        jobs.len() < len_before
    }
}

/// Run a blocking operation against a machine's agent client.
///
/// Handles the common pattern: clone entry → spawn_blocking → lock → connect → op → map errors.
pub async fn with_machine_client<T, F>(
    entry: &Arc<parking_lot::Mutex<MachineEntry>>,
    op: F,
) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&mut crate::agent::AgentClient) -> crate::Result<T> + Send + 'static,
{
    // Clone the Arc<AgentManager> and release the entry lock immediately.
    // AgentManager has its own internal locking, so we don't need to hold
    // the MachineEntry lock during the (potentially slow) VM operation.
    let manager = {
        let entry = entry.lock();
        Arc::clone(&entry.manager)
    };
    tokio::task::spawn_blocking(move || {
        let mut client = manager.connect()?;
        op(&mut client)
    })
    .await?
    .map_err(ApiError::internal)
}

// ============================================================================
// Shared Machine Helpers
// ============================================================================

/// Ensure a machine is running, starting it if needed.
///
/// This is the shared preflight check used by exec, container, and image handlers.
/// It converts the machine's mount/port/resource config and calls
/// `ensure_running_with_full_config` in a blocking task.
pub async fn ensure_machine_running(
    entry: &Arc<parking_lot::Mutex<MachineEntry>>,
) -> crate::Result<()> {
    // Snapshot config and clone manager reference, then release entry lock.
    // The VM boot (5-30s) runs without holding the MachineEntry lock.
    let (manager, mounts, ports, resources) = {
        let entry = entry.lock();
        let mounts: Vec<_> = entry
            .mounts
            .iter()
            .map(HostMount::try_from)
            .collect::<crate::Result<Vec<_>>>()?;
        let ports: Vec<_> = entry.ports.iter().map(PortMapping::from).collect();
        let resources = resource_spec_to_vm_resources(&entry.resources, entry.network);
        (Arc::clone(&entry.manager), mounts, ports, resources)
    };
    tokio::task::spawn_blocking(move || {
        manager.ensure_running_with_full_config(mounts, ports, resources, Default::default())?;
        Ok(())
    })
    .await
    .map_err(|e| crate::Error::agent("ensure running", e.to_string()))?
}

/// Start the secret proxy for a machine if it has secrets configured.
///
/// Called after the VM is started. Spawns a host-side proxy thread that
/// listens on a Unix socket (mapped to vsock port 6100 in the VM).
pub fn start_secret_proxy_if_needed(
    entry: &parking_lot::Mutex<MachineEntry>,
    proxy_config: &RwLock<Option<ProxyConfig>>,
    service_registry: &RwLock<HashMap<String, SecretService>>,
) {
    let entry = entry.lock();
    if entry.secrets.is_empty() {
        return;
    }
    let config_guard = proxy_config.read();
    let proxy_config = match config_guard.as_ref() {
        Some(config) => config,
        None => return,
    };

    let machine_name = entry.manager.name().unwrap_or("unnamed").to_string();
    let proxy_socket = crate::agent::vm_data_dir(&machine_name).join("proxy.sock");

    // Filter the proxy config to only include secrets this machine requested
    let mut machine_secrets = std::collections::HashMap::new();
    for name in &entry.secrets {
        if let Some(key) = proxy_config.secrets.get(name) {
            machine_secrets.insert(name.clone(), key.clone());
        }
    }
    // Use the full service registry (built-in + custom) so user-defined services work
    let all_services = service_registry.read().clone();
    let machine_proxy_config = crate::proxy::ProxyConfig::with_services(machine_secrets, all_services);

    match crate::proxy::start_proxy_listener(&proxy_socket, machine_proxy_config, machine_name) {
        Ok(_handle) => {
            // Thread is detached — it will stop when the socket is closed
            tracing::info!("secret proxy started for machine");
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to start secret proxy");
        }
    }
}

/// Ensure a machine is running and persist the Running state to the database.
///
/// Used by handlers that implicitly start VMs (containers, exec, images).
/// State persistence is best-effort — a DB write failure is logged but does
/// not fail the request, matching the supervisor's error-handling pattern.
pub async fn ensure_running_and_persist(
    state: &ApiState,
    name: &str,
    entry: &Arc<parking_lot::Mutex<MachineEntry>>,
) -> crate::Result<()> {
    ensure_machine_running(entry).await?;

    let pid = {
        let entry = entry.lock();
        entry.manager.child_pid()
    };
    if let Err(e) = state.update_machine_state(name, RecordState::Running, pid) {
        tracing::warn!(machine = %name, error = %e, "failed to persist Running state after implicit start");
    }

    Ok(())
}

// ============================================================================
// Type Conversions
// ============================================================================

impl TryFrom<&MountSpec> for HostMount {
    type Error = crate::Error;

    /// Validate and canonicalize a MountSpec into a HostMount.
    ///
    /// API mount specs require absolute source paths even though CLI parsing
    /// allows relative host paths that are canonicalized against the current
    /// working directory.
    fn try_from(spec: &MountSpec) -> Result<Self, Self::Error> {
        let source = Path::new(&spec.source);
        if !source.is_absolute() {
            return Err(crate::Error::mount(
                "validate source",
                format!("path must be absolute: {}", source.display()),
            ));
        }

        HostMount::new(&spec.source, &spec.target, spec.readonly)
    }
}

impl From<&HostMount> for MountSpec {
    fn from(mount: &HostMount) -> Self {
        MountSpec {
            source: mount.source.to_string_lossy().to_string(),
            target: mount.target.to_string_lossy().to_string(),
            readonly: mount.read_only,
        }
    }
}

impl From<&PortSpec> for PortMapping {
    fn from(spec: &PortSpec) -> Self {
        PortMapping::new(spec.host, spec.guest)
    }
}

impl From<&PortMapping> for PortSpec {
    fn from(mapping: &PortMapping) -> Self {
        PortSpec {
            host: mapping.host,
            guest: mapping.guest,
        }
    }
}

/// Convert multiple MountSpecs to HostMount values.
///
/// Returns an error if any mount fails validation.
pub fn mounts_to_host_mounts(specs: &[MountSpec]) -> Result<Vec<HostMount>, ApiError> {
    specs
        .iter()
        .map(|s| HostMount::try_from(s).map_err(|e| ApiError::BadRequest(e.to_string())))
        .collect()
}

/// Convert ResourceSpec to VmResources.
pub fn resource_spec_to_vm_resources(spec: &ResourceSpec, network: bool) -> VmResources {
    VmResources {
        cpus: spec.cpus.unwrap_or(DEFAULT_MICROVM_CPU_COUNT),
        memory_mib: spec.memory_mb.unwrap_or(DEFAULT_MICROVM_MEMORY_MIB),
        network,
        storage_gib: spec.storage_gb,
        overlay_gib: spec.overlay_gb,
        allowed_cidrs: spec.allowed_cidrs.clone(),
    }
}

/// Convert VmResources to ResourceSpec.
pub fn vm_resources_to_spec(res: VmResources) -> ResourceSpec {
    ResourceSpec {
        cpus: Some(res.cpus),
        memory_mb: Some(res.memory_mib),
        network: Some(res.network),
        storage_gb: res.storage_gib,
        overlay_gb: res.overlay_gib,
        allowed_domains: None,
        allowed_cidrs: res.allowed_cidrs,
    }
}

/// Convert RestartSpec to RestartConfig.
pub fn restart_spec_to_config(spec: Option<&RestartSpec>) -> RestartConfig {
    match spec {
        Some(spec) => {
            let policy = spec
                .policy
                .as_ref()
                .and_then(|p| p.parse::<RestartPolicy>().ok())
                .unwrap_or_default();
            RestartConfig {
                policy,
                max_retries: spec.max_retries.unwrap_or(0),
                max_backoff_secs: 300,
                restart_count: 0,
                user_stopped: false,
            }
        }
        None => RestartConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Create an ApiState with a temporary database for testing.
    fn temp_api_state() -> (TempDir, ApiState) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.redb");
        let db = SmolvmDb::open_at(&path).unwrap();
        (dir, ApiState::with_db(db))
    }

    #[test]
    fn test_type_conversions() {
        // MountSpec -> HostMount preserves readonly flag (use /tmp which exists)
        let spec = MountSpec {
            source: "/tmp".into(),
            target: "/guest".into(),
            readonly: true,
        };
        assert!(HostMount::try_from(&spec).unwrap().read_only);

        let spec = MountSpec {
            source: "/tmp".into(),
            target: "/guest".into(),
            readonly: false,
        };
        assert!(!HostMount::try_from(&spec).unwrap().read_only);

        // ResourceSpec with None uses defaults
        let spec = ResourceSpec {
            cpus: None,
            memory_mb: None,
            network: None,
            storage_gb: None,
            overlay_gb: None,
            allowed_domains: None,
            allowed_cidrs: None,
        };
        let res = resource_spec_to_vm_resources(&spec, false);
        assert_eq!(res.cpus, DEFAULT_MICROVM_CPU_COUNT);
        assert_eq!(res.memory_mib, DEFAULT_MICROVM_MEMORY_MIB);
        assert!(!res.network);

        // Test with network enabled
        let res = resource_spec_to_vm_resources(&spec, true);
        assert!(res.network);
    }

    #[test]
    fn test_machine_not_found() {
        let (_dir, state) = temp_api_state();
        assert!(matches!(
            state.get_machine("nope"),
            Err(ApiError::NotFound(_))
        ));
        assert!(matches!(
            state.remove_machine("nope"),
            Err(ApiError::NotFound(_))
        ));
    }

    // ========================================================================
    // Startup reconciliation tests
    // ========================================================================

    #[test]
    fn test_load_persisted_machines_removes_dead_records() {
        let (_dir, state) = temp_api_state();

        // Insert a record with a PID that doesn't exist (dead process)
        let mut record = VmRecord::new("dead-machine".into(), 1, 512, vec![], vec![], false);
        record.pid = Some(i32::MAX); // PID that certainly doesn't exist
        record.state = RecordState::Running;
        state.db.insert_vm("dead-machine", &record).unwrap();

        // Verify record exists before load
        assert!(state.db.get_vm("dead-machine").unwrap().is_some());

        // Load should detect dead process and clean up DB record
        let loaded = state.load_persisted_machines();
        assert!(loaded.is_empty(), "dead machine should not be loaded");

        // DB record should be cleaned up
        assert!(
            state.db.get_vm("dead-machine").unwrap().is_none(),
            "dead machine DB record should be removed"
        );

        // Name should be available for reuse
        assert!(state.reserve_machine_name("dead-machine").is_ok());
    }

    #[test]
    fn test_load_persisted_machines_dead_record_does_not_block_name() {
        let (_dir, state) = temp_api_state();

        // Insert a dead record with no PID (definitely dead)
        let record = VmRecord::new("ghost".into(), 1, 512, vec![], vec![], false);
        state.db.insert_vm("ghost", &record).unwrap();

        // Load should remove it (no PID = dead)
        let loaded = state.load_persisted_machines();
        assert!(loaded.is_empty());

        // Name should not be blocked
        assert!(
            state.reserve_machine_name("ghost").is_ok(),
            "cleaned-up name should be available for reuse"
        );
    }

    #[test]
    fn test_load_persisted_machines_preserves_alive_unreachable_records() {
        let (_dir, state) = temp_api_state();

        // Use our own PID (always alive and owned by us, so kill(pid,0)==0).
        // AgentManager::for_vm will create a VM directory but reconnect
        // will fail (no socket/agent), so it hits the "alive but unreachable"
        // path. The DB record should be preserved.
        let our_pid = std::process::id() as i32;
        let mut record = VmRecord::new("alive-vm".into(), 1, 512, vec![], vec![], false);
        record.pid = Some(our_pid);
        record.state = RecordState::Running;
        state.db.insert_vm("alive-vm", &record).unwrap();

        // Load — reconnect will fail (no agent socket), but record should
        // be preserved in DB since process is alive
        let _loaded = state.load_persisted_machines();

        // DB record should still exist (not deleted)
        assert!(
            state.db.get_vm("alive-vm").unwrap().is_some(),
            "alive machine DB record should be preserved when reconnect fails"
        );
    }
}
