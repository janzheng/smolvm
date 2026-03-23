//! JSON request and response types for the API.

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

// ============================================================================
// RBAC / Permission Types
// ============================================================================

/// Role-based permission level for sandbox access.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum SandboxRole {
    /// Read-only access: list, get info, read files, view logs.
    ReadOnly,
    /// Operator access: exec, manage files, start/stop — cannot delete.
    Operator,
    /// Full access: create, start, stop, delete, exec, files, grant permissions.
    Owner,
}

impl std::fmt::Display for SandboxRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxRole::ReadOnly => write!(f, "readonly"),
            SandboxRole::Operator => write!(f, "operator"),
            SandboxRole::Owner => write!(f, "owner"),
        }
    }
}

/// A permission grant associating a hashed token with a role on a sandbox.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SandboxPermission {
    /// SHA-256 hash of the bearer token (truncated to 16 hex chars).
    #[schema(example = "a1b2c3d4e5f6a7b8")]
    pub token_hash: String,
    /// Granted role.
    pub role: SandboxRole,
}

/// Request to grant a permission on a sandbox.
#[derive(Debug, Deserialize, ToSchema)]
pub struct GrantPermissionRequest {
    /// The bearer token to grant access to (will be hashed before storage).
    pub token: String,
    /// The role to grant.
    pub role: SandboxRole,
}

/// Response listing permissions on a sandbox.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListPermissionsResponse {
    /// Sandbox name.
    pub sandbox: String,
    /// Current permissions (token hashes + roles).
    pub permissions: Vec<SandboxPermission>,
}

/// Response from granting or revoking a permission.
#[derive(Debug, Serialize, ToSchema)]
pub struct PermissionResponse {
    /// Result message.
    pub message: String,
}

// ============================================================================
// Sandbox Types
// ============================================================================

/// Restart policy specification for sandbox creation.
#[derive(Debug, Clone, Deserialize, Serialize, Default, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RestartSpec {
    /// Restart policy: "never", "always", "on-failure", "unless-stopped".
    #[serde(default)]
    pub policy: Option<String>,
    /// Maximum restart attempts (0 = unlimited).
    #[serde(default)]
    pub max_retries: Option<u32>,
}

/// Request to create a new sandbox.
#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct CreateSandboxRequest {
    /// Unique name for the sandbox.
    #[schema(example = "my-sandbox")]
    pub name: String,
    /// Host mounts to attach.
    #[serde(default)]
    pub mounts: Vec<MountSpec>,
    /// Port mappings (host:guest).
    #[serde(default)]
    pub ports: Vec<PortSpec>,
    /// VM resource configuration.
    #[serde(default)]
    pub resources: Option<ResourceSpec>,
    /// Restart policy configuration.
    #[serde(default)]
    pub restart: Option<RestartSpec>,
    /// Commands to run automatically after sandbox creation.
    /// Each command is executed via `sh -c` in sequence.
    #[serde(default)]
    pub init_commands: Vec<String>,
    /// Create a non-root user and use it as the default for exec calls.
    /// The user is created via `adduser` during sandbox initialization.
    #[serde(default)]
    pub default_user: Option<String>,
    /// Create sandbox from a named starter (e.g., "python-ml", "claude-code").
    /// The starter's OCI image will be pulled and its init commands applied.
    #[serde(default)]
    pub from_starter: Option<String>,
    /// Secret names to inject via the secret proxy (e.g., ["anthropic", "openai"]).
    /// Requires secrets to be configured on the server with `--secret name=value`.
    /// When set, the sandbox gets `*_BASE_URL` env vars pointing to a local proxy
    /// and placeholder API keys. Real keys never enter the VM.
    #[serde(default)]
    pub secrets: Vec<String>,
    /// MCP servers to make available inside the sandbox.
    /// These are queried on-demand via exec when tools are listed or called.
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
}

/// Request to clone an existing sandbox.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CloneSandboxRequest {
    /// Name for the cloned sandbox.
    #[schema(example = "my-sandbox-fork")]
    pub name: String,
}

/// Response from comparing two sandboxes.
#[derive(Debug, Serialize, ToSchema)]
pub struct DiffResponse {
    /// Source sandbox name.
    pub source: String,
    /// Target sandbox name.
    pub target: String,
    /// Files that differ between the two sandboxes.
    pub differences: Vec<String>,
    /// Whether the sandboxes are identical.
    pub identical: bool,
}

/// Request to merge files from one sandbox into another.
#[derive(Debug, Deserialize, ToSchema)]
pub struct MergeSandboxRequest {
    /// Conflict resolution strategy.
    #[serde(default)]
    pub strategy: MergeStrategy,
    /// Specific files to merge (empty = all differences).
    #[serde(default)]
    pub files: Vec<String>,
}

/// Merge conflict resolution strategy.
#[derive(Debug, Default, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum MergeStrategy {
    /// Source wins — overwrite target files.
    #[default]
    Theirs,
    /// Skip files that already exist in target.
    Ours,
}

/// Response from merging two sandboxes.
#[derive(Debug, Serialize, ToSchema)]
pub struct MergeResponse {
    /// Source sandbox name.
    pub source: String,
    /// Target sandbox name.
    pub target: String,
    /// Files that were merged (copied from source to target).
    pub merged_files: Vec<String>,
    /// Files that were skipped (conflict resolution).
    pub skipped_files: Vec<String>,
}

/// Mount specification (for requests).
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct MountSpec {
    /// Host path to mount.
    #[schema(example = "/Users/me/code")]
    pub source: String,
    /// Path inside the sandbox.
    #[schema(example = "/workspace")]
    pub target: String,
    /// Read-only mount.
    #[serde(default)]
    pub readonly: bool,
}

/// Mount information (for responses, includes virtiofs tag).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MountInfo {
    /// Virtiofs tag (e.g., "smolvm0"). Use this in container mounts.
    #[schema(example = "smolvm0")]
    pub tag: String,
    /// Host path.
    #[schema(example = "/Users/me/code")]
    pub source: String,
    /// Path inside the sandbox.
    #[schema(example = "/workspace")]
    pub target: String,
    /// Read-only mount.
    pub readonly: bool,
}

/// Port mapping specification.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct PortSpec {
    /// Port on the host.
    #[schema(example = 8080)]
    pub host: u16,
    /// Port inside the sandbox.
    #[schema(example = 80)]
    pub guest: u16,
}

/// VM resource specification.
#[derive(Debug, Clone, Default, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSpec {
    /// Number of vCPUs.
    #[serde(default)]
    #[schema(example = 2)]
    pub cpus: Option<u8>,
    /// Memory in MiB.
    #[serde(default)]
    #[schema(example = 1024)]
    pub memory_mb: Option<u32>,
    /// Enable outbound network access (TSI).
    /// Note: Only TCP/UDP supported, not ICMP (ping).
    #[serde(default)]
    pub network: Option<bool>,
    /// Storage disk size in GiB (default: 20).
    #[serde(default)]
    #[schema(example = 20)]
    pub storage_gb: Option<u64>,
    /// Overlay disk size in GiB (default: 10).
    #[serde(default)]
    #[schema(example = 10)]
    pub overlay_gb: Option<u64>,
    /// Allowed domains for egress filtering.
    /// When set, only outbound connections to these domains are permitted.
    /// Implies `network: true`. Requires VMM-level enforcement (future work).
    #[serde(default)]
    pub allowed_domains: Option<Vec<String>>,
}

/// Sandbox status information.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SandboxInfo {
    /// Sandbox name.
    #[schema(example = "my-sandbox")]
    pub name: String,
    /// Current state.
    #[schema(example = "running")]
    pub state: String,
    /// Process ID (if running).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = 12345)]
    pub pid: Option<i32>,
    /// Configured mounts (with virtiofs tags for use in container mounts).
    pub mounts: Vec<MountInfo>,
    /// Configured ports.
    pub ports: Vec<PortSpec>,
    /// VM resources.
    pub resources: ResourceSpec,
    /// Whether outbound network access is enabled.
    pub network: bool,
    /// Number of times this sandbox has been automatically restarted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_count: Option<u32>,
}

/// List sandboxes response.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ListSandboxesResponse {
    /// List of sandboxes.
    pub sandboxes: Vec<SandboxInfo>,
}

// ============================================================================
// Exec Types
// ============================================================================

/// Request to execute a command in a sandbox.
#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    /// Command and arguments.
    #[schema(example = json!(["echo", "hello"]))]
    pub command: Vec<String>,
    /// Environment variables.
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Working directory.
    #[serde(default)]
    #[schema(example = "/workspace")]
    pub workdir: Option<String>,
    /// Timeout in seconds.
    #[serde(default)]
    #[schema(example = 30)]
    pub timeout_secs: Option<u64>,
    /// User to run the command as (default: root).
    #[serde(default)]
    pub user: Option<String>,
}

/// Environment variable.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct EnvVar {
    /// Variable name.
    #[schema(example = "MY_VAR")]
    pub name: String,
    /// Variable value.
    #[schema(example = "my_value")]
    pub value: String,
}

impl EnvVar {
    /// Convert a slice of EnvVar to (name, value) tuples for the agent protocol.
    pub fn to_tuples(env: &[EnvVar]) -> Vec<(String, String)> {
        env.iter()
            .map(|e| (e.name.clone(), e.value.clone()))
            .collect()
    }
}

/// Command execution result.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecResponse {
    /// Exit code.
    #[schema(example = 0)]
    pub exit_code: i32,
    /// Standard output.
    #[schema(example = "hello\n")]
    pub stdout: String,
    /// Standard error.
    #[schema(example = "")]
    pub stderr: String,
}

/// Request to run a command in an image.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    /// Image to run in.
    #[schema(example = "python:3.12-alpine")]
    pub image: String,
    /// Command and arguments.
    #[schema(example = json!(["python", "-c", "print('hello')"]))]
    pub command: Vec<String>,
    /// Environment variables.
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Working directory.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Timeout in seconds.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// User to run the command as (default: root).
    #[serde(default)]
    pub user: Option<String>,
}

// ============================================================================
// Container Types
// ============================================================================

/// Request to create a container.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateContainerRequest {
    /// Image to use.
    #[schema(example = "alpine:latest")]
    pub image: String,
    /// Command and arguments.
    #[serde(default)]
    #[schema(example = json!(["sleep", "infinity"]))]
    pub command: Vec<String>,
    /// Environment variables.
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Working directory.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Volume mounts.
    #[serde(default)]
    pub mounts: Vec<ContainerMountSpec>,
}

/// Container mount specification.
///
/// Note: The `source` field is the virtiofs tag, which corresponds to
/// host mounts configured on the sandbox. Tags are assigned in order:
/// `smolvm0`, `smolvm1`, etc. based on the sandbox's mount configuration.
/// Use `GET /api/v1/sandboxes/:id` to see the tag-to-path mapping.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct ContainerMountSpec {
    /// Virtiofs tag (e.g., "smolvm0", "smolvm1").
    /// These correspond to sandbox mounts in order.
    #[schema(example = "smolvm0")]
    pub source: String,
    /// Target path in container.
    #[schema(example = "/app")]
    pub target: String,
    /// Read-only mount.
    #[serde(default)]
    pub readonly: bool,
}

/// Container information.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    /// Container ID.
    #[schema(example = "abc123")]
    pub id: String,
    /// Image.
    #[schema(example = "alpine:latest")]
    pub image: String,
    /// State (created, running, stopped).
    #[schema(example = "running")]
    pub state: String,
    /// Creation timestamp.
    pub created_at: u64,
    /// Command.
    pub command: Vec<String>,
}

/// List containers response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListContainersResponse {
    /// List of containers.
    pub containers: Vec<ContainerInfo>,
}

/// Request to exec in a container.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerExecRequest {
    /// Command and arguments.
    #[schema(example = json!(["ls", "-la"]))]
    pub command: Vec<String>,
    /// Environment variables.
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Working directory.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Timeout in seconds.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// Request to stop a container.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StopContainerRequest {
    /// Timeout before force kill (seconds).
    #[serde(default)]
    #[schema(example = 10)]
    pub timeout_secs: Option<u64>,
}

/// Request to delete a container.
#[derive(Debug, Deserialize, ToSchema)]
pub struct DeleteContainerRequest {
    /// Force delete even if running.
    #[serde(default)]
    pub force: bool,
}

// ============================================================================
// Image Types
// ============================================================================

/// Image information.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    /// Image reference.
    #[schema(example = "alpine:latest")]
    pub reference: String,
    /// Image digest.
    #[schema(example = "sha256:abc123...")]
    pub digest: String,
    /// Size in bytes.
    #[schema(example = 7500000)]
    pub size: u64,
    /// Architecture.
    #[schema(example = "arm64")]
    pub architecture: String,
    /// OS.
    #[schema(example = "linux")]
    pub os: String,
    /// Number of layers.
    #[schema(example = 3)]
    pub layer_count: usize,
}

/// List images response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListImagesResponse {
    /// List of images.
    pub images: Vec<ImageInfo>,
}

/// Request to pull an image.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullImageRequest {
    /// Image reference.
    #[schema(example = "python:3.12-alpine")]
    pub image: String,
    /// OCI platform for multi-arch images (e.g., "linux/arm64").
    #[serde(default)]
    #[schema(example = "linux/arm64")]
    pub oci_platform: Option<String>,
}

/// Pull image response.
#[derive(Debug, Serialize, ToSchema)]
pub struct PullImageResponse {
    /// Information about the pulled image.
    pub image: ImageInfo,
}

// ============================================================================
// Logs Types
// ============================================================================

/// Query parameters for logs endpoint.
#[derive(Debug, Deserialize, ToSchema)]
pub struct LogsQuery {
    /// If true, follow the logs (like tail -f). Default: false.
    #[serde(default)]
    pub follow: bool,
    /// Number of lines to show from the end (like tail -n). Default: all.
    #[serde(default)]
    #[schema(example = 100)]
    pub tail: Option<usize>,
}

// ============================================================================
// Delete Types
// ============================================================================

/// Query parameters for delete sandbox endpoint.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct DeleteQuery {
    /// If true, force delete even if stop fails and VM is still running.
    /// This may orphan the VM process. Default: false.
    #[serde(default)]
    pub force: bool,
}

// ============================================================================
// Health Types
// ============================================================================

/// Health check response.
#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    /// Health status (e.g., "ok").
    #[schema(example = "ok")]
    pub status: &'static str,
    /// Server version.
    #[schema(example = "0.1.6")]
    pub version: &'static str,
}

// ============================================================================
// Error Types
// ============================================================================

/// API error response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiErrorResponse {
    /// Error message.
    #[schema(example = "sandbox 'test' not found")]
    pub error: String,
    /// Error code.
    #[schema(example = "NOT_FOUND")]
    pub code: String,
}

// ============================================================================
// MicroVM Types
// ============================================================================

fn default_cpus() -> u8 {
    1
}

fn default_mem() -> u32 {
    512
}

/// Request to create a new microvm.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateMicrovmRequest {
    /// Unique name for the microvm.
    #[schema(example = "my-vm")]
    pub name: String,
    /// Number of vCPUs.
    #[serde(default = "default_cpus")]
    #[schema(example = 2)]
    pub cpus: u8,
    /// Memory in MiB.
    #[serde(default = "default_mem", rename = "memoryMb")]
    #[schema(example = 1024)]
    pub mem: u32,
    /// Host mounts to attach.
    #[serde(default)]
    pub mounts: Vec<MountSpec>,
    /// Port mappings (host:guest).
    #[serde(default)]
    pub ports: Vec<PortSpec>,
    /// Enable outbound network access (TSI).
    /// Note: Only TCP/UDP supported, not ICMP (ping).
    #[serde(default)]
    pub network: bool,
    /// Storage disk size in GiB (default: 20).
    #[serde(default)]
    pub storage_gb: Option<u64>,
    /// Overlay disk size in GiB (default: 10).
    #[serde(default)]
    pub overlay_gb: Option<u64>,
}

/// Request to execute a command in a microvm.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MicrovmExecRequest {
    /// Command and arguments.
    #[schema(example = json!(["echo", "hello"]))]
    pub command: Vec<String>,
    /// Environment variables.
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Working directory.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Timeout in seconds.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// MicroVM status information.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MicrovmInfo {
    /// MicroVM name.
    #[schema(example = "my-vm")]
    pub name: String,
    /// Current state ("created", "running", "stopped").
    #[schema(example = "running")]
    pub state: String,
    /// Number of vCPUs.
    #[schema(example = 2)]
    pub cpus: u8,
    /// Memory in MiB.
    #[serde(rename = "memoryMb")]
    #[schema(example = 1024)]
    pub mem: u32,
    /// Process ID (if running).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = 12345)]
    pub pid: Option<i32>,
    /// Number of configured mounts.
    pub mounts: usize,
    /// Number of configured ports.
    pub ports: usize,
    /// Whether outbound network access is enabled.
    pub network: bool,
    /// Storage disk size in GiB.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = 20)]
    pub storage_gb: Option<u64>,
    /// Overlay disk size in GiB.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = 2)]
    pub overlay_gb: Option<u64>,
    /// Creation timestamp.
    pub created_at: String,
}

/// List microvms response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListMicrovmsResponse {
    /// List of microvms.
    pub microvms: Vec<MicrovmInfo>,
}

/// Generic delete response.
#[derive(Debug, Serialize, ToSchema)]
pub struct DeleteResponse {
    /// Name of deleted resource.
    #[schema(example = "my-sandbox")]
    pub deleted: String,
}

/// Generic start response.
#[derive(Debug, Serialize, ToSchema)]
pub struct StartResponse {
    /// Identifier of started resource.
    #[schema(example = "abc123")]
    pub started: String,
}

/// Generic stop response.
#[derive(Debug, Serialize, ToSchema)]
pub struct StopResponse {
    /// Identifier of stopped resource.
    #[schema(example = "abc123")]
    pub stopped: String,
}

// ============================================================================
// File Types
// ============================================================================

/// Information about a file or directory in a sandbox.
#[derive(Debug, Serialize, ToSchema)]
pub struct FileInfo {
    /// File path.
    pub path: String,
    /// File name.
    pub name: String,
    /// Size in bytes.
    pub size: u64,
    /// Whether this is a directory.
    pub is_dir: bool,
    /// Unix permissions (e.g., "0644").
    pub permissions: String,
}

/// Request to write a file in a sandbox.
#[derive(Debug, Deserialize, ToSchema)]
pub struct WriteFileRequest {
    /// File content (base64-encoded).
    pub content: String,
    /// Optional Unix permissions (e.g., "0755"). Default: 0644.
    #[serde(default)]
    pub permissions: Option<String>,
}

/// Response from reading a file.
#[derive(Debug, Serialize, ToSchema)]
pub struct ReadFileResponse {
    /// File content (base64-encoded).
    pub content: String,
}

/// Response listing files in a directory.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListFilesResponse {
    /// Directory path.
    pub directory: String,
    /// Files in the directory.
    pub files: Vec<FileInfo>,
}

/// Query parameters for listing files.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ListFilesQuery {
    /// Directory to list. Default: "/".
    #[serde(default = "default_root_dir")]
    pub dir: String,
}

fn default_root_dir() -> String {
    "/".to_string()
}

// ============================================================================
// Debug Types
// ============================================================================

/// Debug information about sandbox mounts.
#[derive(Debug, Serialize, ToSchema)]
pub struct DebugMountsResponse {
    /// Configured mounts.
    pub configured: Vec<MountInfo>,
    /// Guest-side `mount` output.
    pub guest_mounts: String,
    /// Guest-side `/mnt/` listing.
    pub mnt_listing: String,
    /// Whether virtiofs is supported in the guest kernel.
    pub virtiofs_supported: bool,
}

/// Debug information about sandbox networking.
#[derive(Debug, Serialize, ToSchema)]
pub struct DebugNetworkResponse {
    /// Configured port mappings.
    pub configured_ports: Vec<PortSpec>,
    /// Guest-side listening ports (ss -tlnp output).
    pub listening_ports: String,
    /// Guest-side network interfaces (ip addr output).
    pub interfaces: String,
    /// Whether networking is enabled.
    pub network_enabled: bool,
}

// ============================================================================
// DNS Filter Types
// ============================================================================

/// DNS filtering status for a sandbox.
#[derive(Debug, Serialize, ToSchema)]
pub struct DnsFilterStatus {
    /// Whether DNS-based egress filtering is active.
    pub active: bool,
    /// Allowed domains (empty if filtering is not active).
    #[serde(default)]
    pub allowed_domains: Vec<String>,
}

// ============================================================================
// Starter Types
// ============================================================================

/// Information about an available starter.
#[derive(Debug, Serialize, ToSchema)]
pub struct StarterInfo {
    /// Starter name.
    #[schema(example = "python-ml")]
    pub name: String,
    /// OCI image reference.
    #[schema(example = "ghcr.io/smol-machines/smolvm-python-ml:latest")]
    pub image: String,
    /// Description of what's included.
    pub description: String,
    /// Default non-root user.
    pub default_user: Option<String>,
}

/// List starters response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListStartersResponse {
    /// Available starters.
    pub starters: Vec<StarterInfo>,
}

// ============================================================================
// Snapshot Types
// ============================================================================

/// Default snapshot version (full archive).
fn default_snapshot_version() -> u32 {
    1
}

/// Snapshot manifest metadata.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SnapshotManifest {
    /// Snapshot name (usually matches source sandbox name).
    pub name: String,
    /// Platform (e.g., "aarch64-macos").
    pub platform: String,
    /// Network enabled.
    pub network: bool,
    /// Creation timestamp (ISO 8601).
    pub created_at: String,
    /// Overlay disk size in bytes.
    pub overlay_size_bytes: u64,
    /// Storage disk size in bytes.
    pub storage_size_bytes: u64,
    /// Human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Owner identifier (e.g., username or email).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// Parent snapshot name (for lineage tracking).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_snapshot: Option<String>,
    /// Git branch at time of snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// Git commit hash at time of snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_commit: Option<String>,
    /// Whether workspace had uncommitted changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_dirty: Option<bool>,
    /// SHA-256 hash of the archive file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Snapshot format version: 1 = full archive, 2 = incremental delta.
    #[serde(default = "default_snapshot_version")]
    pub snapshot_version: u32,
    /// SHA-256 of the parent archive (for delta validation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_sha256: Option<String>,
    /// Block size used for delta computation (default: 4096).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_size: Option<u32>,
    /// Number of changed overlay blocks in this delta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay_changed_blocks: Option<u64>,
    /// Number of changed storage blocks in this delta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_changed_blocks: Option<u64>,
    /// Sequence number within a sandbox's snapshot history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u32>,
}

/// List snapshots response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListSnapshotsResponse {
    /// Available snapshots.
    pub snapshots: Vec<SnapshotManifest>,
}

/// Request to pull a snapshot into a new sandbox.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PullSnapshotRequest {
    /// Name for the new sandbox.
    #[schema(example = "my-restored-sandbox")]
    pub name: String,
}

/// Request body for pushing a snapshot (all fields optional).
#[derive(Debug, Deserialize, ToSchema, Default)]
pub struct PushSnapshotRequest {
    /// Human-readable description of the snapshot.
    #[serde(default)]
    pub description: Option<String>,
    /// Parent snapshot name (for lineage tracking).
    #[serde(default)]
    pub parent_snapshot: Option<String>,
    /// Request incremental (delta) snapshot if parent is available.
    #[serde(default)]
    pub incremental: Option<bool>,
}

/// Response from pushing a snapshot.
#[derive(Debug, Serialize, ToSchema)]
pub struct PushSnapshotResponse {
    /// Snapshot name.
    pub name: String,
    /// Path to the snapshot archive.
    pub path: String,
    /// Manifest metadata.
    pub manifest: SnapshotManifest,
}

/// Query parameters for snapshot upload.
#[derive(Debug, Deserialize, ToSchema, IntoParams)]
pub struct UploadSnapshotQuery {
    /// Name for the uploaded snapshot (without extension).
    #[schema(example = "my-snapshot")]
    pub name: String,
}

/// Response from uploading a snapshot.
#[derive(Debug, Serialize, ToSchema)]
pub struct UploadSnapshotResponse {
    /// Snapshot name.
    pub name: String,
    /// Size of the uploaded archive in bytes.
    pub size_bytes: u64,
    /// Manifest metadata extracted from the archive.
    pub manifest: SnapshotManifest,
}

/// Response from snapshot history endpoint.
#[derive(Debug, Serialize, ToSchema)]
pub struct SnapshotHistoryResponse {
    /// Chain of snapshots, newest first.
    pub chain: Vec<SnapshotManifest>,
    /// Total number of snapshots in the chain.
    pub total_snapshots: usize,
    /// Number of full snapshots in the chain.
    pub full_snapshots: usize,
    /// Number of incremental snapshots in the chain.
    pub incremental_snapshots: usize,
    /// Total size of all archives in bytes.
    pub total_size_bytes: u64,
}

/// Request to rollback a sandbox to a specific snapshot version.
#[derive(Debug, Deserialize, ToSchema)]
pub struct RollbackRequest {
    /// Name of the sandbox to restore into.
    #[schema(example = "my-sandbox")]
    pub sandbox_name: String,
    /// Specific version number to rollback to (latest if omitted).
    #[serde(default)]
    pub version: Option<u32>,
}

/// Response from rollback endpoint.
#[derive(Debug, Serialize, ToSchema)]
pub struct RollbackResponse {
    /// Sandbox that was restored.
    pub sandbox_name: String,
    /// Snapshot version that was restored.
    pub restored_version: u32,
    /// Manifest of the restored snapshot.
    pub manifest: SnapshotManifest,
}

/// Request to squash a snapshot chain into a single full archive.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SquashSnapshotRequest {
    /// Keep the original versioned archives after squashing (default: false).
    #[serde(default)]
    pub keep_originals: Option<bool>,
}

// ============================================================================
// Resource Stats
// ============================================================================

/// Disk usage statistics for a VM disk image.
#[derive(Debug, Serialize, ToSchema)]
pub struct DiskStats {
    /// Path to the disk image on the host.
    pub path: String,
    /// Apparent (logical) size in bytes.
    pub apparent_size_bytes: u64,
    /// Apparent (logical) size in GB.
    pub apparent_size_gb: f64,
}

/// Resource statistics response for a sandbox.
#[derive(Debug, Serialize, ToSchema)]
pub struct ResourceStatsResponse {
    /// Sandbox name.
    pub name: String,
    /// Current state (created, running, stopped).
    pub state: String,
    /// Process ID if running.
    pub pid: Option<i32>,
    /// Number of CPUs allocated.
    pub cpus: u8,
    /// Memory allocated in MB.
    pub memory_mb: u32,
    /// Whether networking is enabled.
    pub network: bool,
    /// Overlay disk usage.
    pub overlay_disk: Option<DiskStats>,
    /// Storage disk usage.
    pub storage_disk: Option<DiskStats>,
}

// ============================================================================
// Work Queue / Job Types
// ============================================================================

/// Request to submit a new job to the work queue.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SubmitJobRequest {
    /// Target sandbox to execute in.
    #[schema(example = "my-sandbox")]
    pub sandbox: String,
    /// Command to execute.
    pub command: Vec<String>,
    /// Environment variables for the command.
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Working directory for command execution.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Execution timeout in seconds (default: 300).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Maximum retry attempts on failure (default: 0 = no retry).
    #[serde(default)]
    pub max_retries: Option<u32>,
    /// Arbitrary metadata labels for filtering/grouping.
    #[serde(default)]
    pub labels: std::collections::HashMap<String, String>,
    /// Priority (higher = sooner). Default: 0.
    #[serde(default)]
    pub priority: i32,
}

/// Job status in the work queue lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    /// Job is waiting to be claimed.
    Queued,
    /// Job has been claimed and is executing.
    Running,
    /// Job completed successfully.
    Completed,
    /// Job failed (may be retried).
    Failed,
    /// Job exhausted all retries.
    Dead,
}

impl std::fmt::Display for JobStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobStatus::Queued => write!(f, "queued"),
            JobStatus::Running => write!(f, "running"),
            JobStatus::Completed => write!(f, "completed"),
            JobStatus::Failed => write!(f, "failed"),
            JobStatus::Dead => write!(f, "dead"),
        }
    }
}

/// A job in the work queue.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct JobInfo {
    /// Unique job identifier.
    pub id: String,
    /// Target sandbox name.
    pub sandbox: String,
    /// Command to execute.
    pub command: Vec<String>,
    /// Environment variables.
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Working directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    /// Execution timeout in seconds.
    pub timeout_secs: u64,
    /// Current job status.
    pub status: JobStatus,
    /// Max retry attempts.
    pub max_retries: u32,
    /// Number of attempts so far.
    pub attempts: u32,
    /// Priority (higher = sooner).
    pub priority: i32,
    /// Metadata labels.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub labels: std::collections::HashMap<String, String>,
    /// Job creation timestamp (Unix epoch seconds).
    pub created_at: u64,
    /// Job start timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    /// Job completion timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    /// Execution result (populated on completion).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ExecResponse>,
    /// Error message (populated on failure).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Response after submitting a job.
#[derive(Debug, Serialize, ToSchema)]
pub struct SubmitJobResponse {
    /// Assigned job ID.
    pub id: String,
    /// Initial status (always "queued").
    pub status: JobStatus,
}

/// Response listing jobs.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListJobsResponse {
    /// List of jobs.
    pub jobs: Vec<JobInfo>,
}

/// Query parameters for listing/polling jobs.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
pub struct JobsQuery {
    /// Filter by status (queued, running, completed, failed, dead).
    #[serde(default)]
    pub status: Option<String>,
    /// Filter by sandbox name.
    #[serde(default)]
    pub sandbox: Option<String>,
    /// Maximum number of results.
    #[serde(default)]
    pub limit: Option<usize>,
}

/// Request to complete a job with result.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CompleteJobRequest {
    /// Exit code of the executed command.
    pub exit_code: i32,
    /// Standard output.
    #[serde(default)]
    pub stdout: String,
    /// Standard error.
    #[serde(default)]
    pub stderr: String,
}

/// Request to fail a job with error message.
#[derive(Debug, Deserialize, ToSchema)]
pub struct FailJobRequest {
    /// Error description.
    pub error: String,
}

// ============================================================================
// Secret Types
// ============================================================================

/// Request to update secrets at runtime (hot-reload).
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateSecretsRequest {
    /// Map of secret name to new value (e.g., {"anthropic": "sk-new-key"}).
    pub secrets: std::collections::HashMap<String, String>,
}

/// Response from updating secrets.
#[derive(Debug, Serialize, ToSchema)]
pub struct UpdateSecretsResponse {
    /// List of secret names that were updated.
    pub updated: Vec<String>,
}

/// Response listing configured secret and service names (never exposes values).
#[derive(Debug, Serialize, ToSchema)]
pub struct ListSecretsResponse {
    /// Configured secret names (e.g., ["anthropic", "openai"]).
    pub secrets: Vec<String>,
    /// Known service names with matching secrets.
    pub services: Vec<String>,
}

// ============================================================================
// MCP (Model Context Protocol) Types
// ============================================================================

/// Configuration for an MCP server to run inside a sandbox.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct McpServerConfig {
    /// Display name for the MCP server.
    #[schema(example = "filesystem")]
    pub name: String,
    /// Command to start the server (e.g., ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/workspace"]).
    #[schema(example = json!(["npx", "-y", "@modelcontextprotocol/server-filesystem", "/workspace"]))]
    pub command: Vec<String>,
    /// Environment variables for the server process.
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Working directory for the server.
    #[serde(default)]
    pub workdir: Option<String>,
}

/// Information about a tool exposed by an MCP server.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct McpToolInfo {
    /// Name of the MCP server providing this tool.
    pub server: String,
    /// Tool name.
    pub name: String,
    /// Tool description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSON Schema for the tool's input parameters.
    pub input_schema: serde_json::Value,
}

/// Response listing MCP tools discovered from configured servers.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ListMcpToolsResponse {
    /// All discovered tools across all servers.
    pub tools: Vec<McpToolInfo>,
    /// Status of each configured MCP server.
    pub servers: Vec<McpServerStatus>,
}

/// Status of an MCP server.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct McpServerStatus {
    /// Server name.
    pub name: String,
    /// Whether the server responded successfully.
    pub running: bool,
    /// Number of tools discovered from this server.
    pub tool_count: usize,
}

/// Request to call a tool on an MCP server.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CallMcpToolRequest {
    /// Name of the MCP server to call.
    #[schema(example = "filesystem")]
    pub server: String,
    /// Tool name to invoke.
    #[schema(example = "read_file")]
    pub tool: String,
    /// Arguments to pass to the tool (JSON object).
    pub arguments: serde_json::Value,
}

/// Response from calling an MCP tool.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CallMcpToolResponse {
    /// Content items returned by the tool.
    pub content: Vec<serde_json::Value>,
    /// Whether the tool call resulted in an error.
    pub is_error: bool,
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_strategy_default_is_theirs() {
        let strategy: MergeStrategy = Default::default();
        assert!(matches!(strategy, MergeStrategy::Theirs));
    }

    #[test]
    fn test_merge_strategy_deserialize() {
        let theirs: MergeStrategy = serde_json::from_str("\"theirs\"").unwrap();
        assert!(matches!(theirs, MergeStrategy::Theirs));

        let ours: MergeStrategy = serde_json::from_str("\"ours\"").unwrap();
        assert!(matches!(ours, MergeStrategy::Ours));
    }

    #[test]
    fn test_merge_strategy_serialize() {
        let json = serde_json::to_string(&MergeStrategy::Theirs).unwrap();
        assert_eq!(json, "\"theirs\"");

        let json = serde_json::to_string(&MergeStrategy::Ours).unwrap();
        assert_eq!(json, "\"ours\"");
    }

    #[test]
    fn test_merge_request_defaults() {
        let req: MergeSandboxRequest = serde_json::from_str("{}").unwrap();
        assert!(matches!(req.strategy, MergeStrategy::Theirs));
        assert!(req.files.is_empty());
    }

    #[test]
    fn test_merge_request_with_files() {
        let json = r#"{"strategy":"ours","files":["/app/main.ts","/app/config.json"]}"#;
        let req: MergeSandboxRequest = serde_json::from_str(json).unwrap();
        assert!(matches!(req.strategy, MergeStrategy::Ours));
        assert_eq!(req.files.len(), 2);
        assert_eq!(req.files[0], "/app/main.ts");
    }

    #[test]
    fn test_exec_request_user_field() {
        let json = r#"{"command":["echo","hi"],"user":"agent"}"#;
        let req: ExecRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.user, Some("agent".into()));
    }

    #[test]
    fn test_exec_request_no_user() {
        let json = r#"{"command":["echo","hi"]}"#;
        let req: ExecRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.user, None);
    }

    #[test]
    fn test_merge_response_serializes() {
        let resp = MergeResponse {
            source: "src".into(),
            target: "tgt".into(),
            merged_files: vec!["/app/a.txt".into()],
            skipped_files: vec!["/app/b.txt".into()],
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["source"], "src");
        assert_eq!(json["merged_files"][0], "/app/a.txt");
        assert_eq!(json["skipped_files"][0], "/app/b.txt");
    }

    #[test]
    fn test_create_sandbox_request_default_user() {
        let json = r#"{"name":"test","default_user":"agent"}"#;
        let req: CreateSandboxRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.default_user, Some("agent".into()));
    }

    #[test]
    fn test_create_sandbox_request_no_default_user() {
        let json = r#"{"name":"test"}"#;
        let req: CreateSandboxRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.default_user, None);
    }

    #[test]
    fn test_resource_stats_response_serializes() {
        let resp = ResourceStatsResponse {
            name: "test".into(),
            state: "running".into(),
            pid: Some(1234),
            cpus: 2,
            memory_mb: 1024,
            network: true,
            overlay_disk: Some(DiskStats {
                path: "/tmp/overlay.raw".into(),
                apparent_size_bytes: 1073741824,
                apparent_size_gb: 1.0,
            }),
            storage_disk: None,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["name"], "test");
        assert_eq!(json["cpus"], 2);
        assert!(json["overlay_disk"].is_object());
        assert!(json["storage_disk"].is_null());
    }
}

// ============================================================================
// Service Types
// ============================================================================

/// Information about a proxy service definition (secrets are not included).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ServiceInfo {
    /// Short name (e.g., "anthropic", "openai", "github").
    #[schema(example = "anthropic")]
    pub name: String,
    /// Base URL for the real API.
    #[schema(example = "https://api.anthropic.com")]
    pub base_url: String,
    /// HTTP header name for authentication.
    #[schema(example = "x-api-key")]
    pub auth_header: String,
    /// Prefix before the key value.
    #[schema(example = "")]
    pub auth_prefix: String,
    /// Environment variable name for the API key inside the VM.
    #[schema(example = "ANTHROPIC_API_KEY")]
    pub env_key_name: String,
    /// Environment variable name for the base URL inside the VM.
    #[schema(example = "ANTHROPIC_BASE_URL")]
    pub env_url_name: String,
}

/// Response listing available proxy services.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ListServicesResponse {
    /// List of service definitions.
    pub services: Vec<ServiceInfo>,
}

/// Request to register a new proxy service definition.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateServiceRequest {
    /// Short name for the service (used in proxy paths).
    #[schema(example = "github")]
    pub name: String,
    /// Base URL for the real API.
    #[schema(example = "https://api.github.com")]
    pub base_url: String,
    /// HTTP header name for authentication.
    #[schema(example = "Authorization")]
    pub auth_header: String,
    /// Prefix before the key value (e.g., "Bearer ").
    #[schema(example = "Bearer ")]
    #[serde(default)]
    pub auth_prefix: Option<String>,
    /// Environment variable name for the API key inside the VM.
    #[schema(example = "GITHUB_TOKEN")]
    pub env_key_name: String,
    /// Environment variable name for the base URL inside the VM.
    #[schema(example = "GITHUB_API_URL")]
    pub env_url_name: String,
}

// ============================================================================
// Provider Types
// ============================================================================

/// Provider information response (returned by GET /api/v1/provider).
#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub struct ProviderInfoResponse {
    /// Provider name (e.g., "local").
    #[schema(example = "local")]
    pub name: String,
    /// Provider version.
    #[schema(example = "0.1.17")]
    pub version: String,
    /// Supported capabilities.
    pub capabilities: Vec<String>,
    /// Maximum number of sandboxes (null = unlimited).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_sandboxes: Option<usize>,
    /// Provider region / location.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

// ============================================================================
// Resize Types
// ============================================================================

/// Request to resize a microvm's disk resources.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResizeMicrovmRequest {
    /// Storage disk size in GiB (expand only, optional).
    #[serde(default)]
    #[schema(example = 50)]
    pub storage_gb: Option<u64>,
    /// Overlay disk size in GiB (expand only, optional).
    #[serde(default)]
    #[schema(example = 20)]
    pub overlay_gb: Option<u64>,
}
