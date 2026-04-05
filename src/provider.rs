//! Provider abstraction for machine management.
//!
//! The `MachineProvider` trait abstracts machine lifecycle operations so that
//! different backends (local, remote HTTP, Fly.io, Cloudflare, etc.) can be
//! used interchangeably.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::api::types::{CreateMachineRequest, ExecRequest, ExecResponse, MachineInfo};

/// Provider capabilities — what a provider supports.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProviderInfo {
    /// Provider name (e.g., "local", "remote", "fly").
    pub name: String,
    /// Provider version string.
    pub version: String,
    /// Supported capabilities (e.g., ["exec", "files", "mcp", "secrets", "merge", "clone"]).
    pub capabilities: Vec<String>,
    /// Maximum number of machinees this provider can manage (None = unlimited).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_machinees: Option<usize>,
    /// Region or location label (e.g., "local", "us-east-1").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

/// Errors from provider operations.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// The requested machine was not found.
    #[error("machine not found: {0}")]
    NotFound(String),
    /// Internal provider error.
    #[error("provider error: {0}")]
    Internal(String),
    /// The requested operation is not supported by this provider.
    #[error("not supported: {0}")]
    NotSupported(String),
    /// Failed to connect to the provider backend.
    #[error("connection error: {0}")]
    Connection(String),
}

/// A machine provider manages machine lifecycle on some infrastructure.
///
/// Implementations may wrap a local `ApiState` (for in-process management),
/// talk to a remote smolvm instance via HTTP, or integrate with cloud
/// platforms like Fly.io or Cloudflare.
#[async_trait]
pub trait MachineProvider: Send + Sync {
    /// Provider metadata and capabilities.
    fn info(&self) -> ProviderInfo;

    /// Create a new machine.
    async fn create(&self, req: CreateMachineRequest) -> Result<MachineInfo, ProviderError>;

    /// Start an existing machine.
    async fn start(&self, id: &str) -> Result<MachineInfo, ProviderError>;

    /// Stop a running machine.
    async fn stop(&self, id: &str) -> Result<(), ProviderError>;

    /// Delete a machine (stops it first if running).
    async fn delete(&self, id: &str) -> Result<(), ProviderError>;

    /// Get machine info by name.
    async fn get(&self, id: &str) -> Result<MachineInfo, ProviderError>;

    /// List all machinees managed by this provider.
    async fn list(&self) -> Result<Vec<MachineInfo>, ProviderError>;

    /// Execute a command in a machine.
    async fn exec(&self, id: &str, req: ExecRequest) -> Result<ExecResponse, ProviderError>;

    /// Health check — returns true if the provider backend is reachable.
    async fn health(&self) -> Result<bool, ProviderError>;
}
