//! Local sandbox provider — wraps the in-process `ApiState`.
//!
//! This provider delegates directly to the existing sandbox management logic,
//! making it a thin adapter from the `SandboxProvider` trait to `ApiState`.

use async_trait::async_trait;
use std::sync::Arc;

use crate::api::error::ApiError;
use crate::api::handlers::sandboxes::sandbox_entry_to_info;
use crate::api::state::{
    ensure_sandbox_running, with_sandbox_client, ApiState,
};
use crate::api::types::{
    CreateSandboxRequest, EnvVar, ExecRequest, ExecResponse, SandboxInfo,
};
use crate::provider::{ProviderError, ProviderInfo, SandboxProvider};

/// Local provider that manages sandboxes on the current machine via `ApiState`.
pub struct LocalProvider {
    state: Arc<ApiState>,
}

impl LocalProvider {
    /// Create a new local provider wrapping the given API state.
    pub fn new(state: Arc<ApiState>) -> Self {
        Self { state }
    }
}

/// Convert an `ApiError` into a `ProviderError`.
fn api_err_to_provider(e: ApiError) -> ProviderError {
    match e {
        ApiError::NotFound(msg) => ProviderError::NotFound(msg),
        ApiError::Conflict(msg) => ProviderError::Internal(format!("conflict: {}", msg)),
        ApiError::BadRequest(msg) => ProviderError::Internal(format!("bad request: {}", msg)),
        ApiError::Timeout => ProviderError::Internal("timeout".into()),
        ApiError::Unauthorized(msg) => ProviderError::Internal(format!("unauthorized: {}", msg)),
        ApiError::Forbidden(msg) => ProviderError::Internal(format!("forbidden: {}", msg)),
        ApiError::Internal(msg) => ProviderError::Internal(msg),
    }
}

#[async_trait]
impl SandboxProvider for LocalProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            name: "local".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            capabilities: vec![
                "exec", "files", "mcp", "secrets", "merge", "clone",
                "snapshots", "containers", "images",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            max_sandboxes: None,
            region: Some("local".into()),
        }
    }

    async fn create(&self, _req: CreateSandboxRequest) -> Result<SandboxInfo, ProviderError> {
        // Full sandbox creation involves RAII reservation guards, starter
        // configuration, init commands, DNS filtering, etc. — all tightly
        // coupled to the Axum handler pipeline. Instead of duplicating that
        // logic, callers should use the HTTP API (which the RemoteProvider
        // wraps). The local provider exposes the simpler lifecycle operations.
        Err(ProviderError::NotSupported(
            "use the HTTP API for sandbox creation (complex init pipeline)".into(),
        ))
    }

    async fn start(&self, id: &str) -> Result<SandboxInfo, ProviderError> {
        let entry = self.state.get_sandbox(id).map_err(api_err_to_provider)?;

        ensure_sandbox_running(&entry)
            .await
            .map_err(|e| ProviderError::Internal(e.to_string()))?;

        // Persist state
        let pid = {
            let entry = entry.lock();
            entry.manager.child_pid()
        };
        let _ = self
            .state
            .update_sandbox_state(id, crate::config::RecordState::Running, pid);

        // Build response
        let entry = entry.lock();
        Ok(sandbox_entry_to_info(id.to_string(), &entry))
    }

    async fn stop(&self, id: &str) -> Result<(), ProviderError> {
        let entry = self.state.get_sandbox(id).map_err(api_err_to_provider)?;

        let manager = {
            let entry = entry.lock();
            Arc::clone(&entry.manager)
        };

        tokio::task::spawn_blocking(move || manager.stop())
            .await
            .map_err(|e| ProviderError::Internal(e.to_string()))?
            .map_err(|e| ProviderError::Internal(e.to_string()))?;

        let _ = self.state.update_sandbox_state(
            id,
            crate::config::RecordState::Stopped,
            None,
        );

        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<(), ProviderError> {
        // Stop first (ignore errors — sandbox may already be stopped)
        let _ = self.stop(id).await;

        self.state
            .remove_sandbox(id)
            .map_err(api_err_to_provider)?;

        // Clean up data directory
        let data_dir = crate::agent::vm_data_dir(id);
        if data_dir.exists() {
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        Ok(())
    }

    async fn get(&self, id: &str) -> Result<SandboxInfo, ProviderError> {
        let entry = self.state.get_sandbox(id).map_err(api_err_to_provider)?;
        let entry = entry.lock();
        Ok(sandbox_entry_to_info(id.to_string(), &entry))
    }

    async fn list(&self) -> Result<Vec<SandboxInfo>, ProviderError> {
        Ok(self.state.list_sandboxes())
    }

    async fn exec(
        &self,
        id: &str,
        req: ExecRequest,
    ) -> Result<ExecResponse, ProviderError> {
        let entry = self.state.get_sandbox(id).map_err(api_err_to_provider)?;

        // Ensure running
        ensure_sandbox_running(&entry)
            .await
            .map_err(|e| ProviderError::Internal(e.to_string()))?;

        let command = req.command.clone();
        let env = EnvVar::to_tuples(&req.env);
        let workdir = req.workdir.clone();
        let timeout = req.timeout_secs.map(std::time::Duration::from_secs);
        let user = req.user.clone();

        let (exit_code, stdout, stderr) =
            with_sandbox_client(&entry, move |c| {
                c.vm_exec_as(command, env, workdir, timeout, user)
            })
            .await
            .map_err(api_err_to_provider)?;

        Ok(ExecResponse {
            exit_code,
            stdout,
            stderr,
        })
    }

    async fn health(&self) -> Result<bool, ProviderError> {
        // Local provider is always healthy if we're running
        Ok(true)
    }
}
