/**
 * smolvm TypeScript SDK — Type Definitions
 *
 * Derived from smolvm's OpenAPI spec (v0.1.6).
 * Covers both Sandbox and MicroVM APIs.
 */

// ============================================================================
// Shared
// ============================================================================

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  env?: EnvVar[];
  workdir?: string;
  timeout_secs?: number;
  /** Run command as this user instead of root. */
  user?: string;
}

export interface EnvVar {
  name: string;
  value: string;
}

export interface MountSpec {
  source: string;
  target: string;
  readonly?: boolean;
}

export interface PortSpec {
  host: number;
  guest: number;
}

export interface HealthResponse {
  status: string;
  version: string;
}

// ============================================================================
// Sandbox
// ============================================================================

export interface CreateSandboxOptions {
  cpus?: number;
  memoryMb?: number;
  network?: boolean;
  overlay_gb?: number;
  storage_gb?: number;
  mounts?: MountSpec[];
  ports?: PortSpec[];
  /** Commands to run automatically after sandbox creation. */
  init_commands?: string[];
  /** Allowed domains for egress filtering. Implies network: true. */
  allowed_domains?: string[];
  /** Create a non-root user and use it for subsequent exec calls. */
  default_user?: string;
  /** Create sandbox from a starter template. */
  fromStarter?: string;
  /**
   * Secret names to inject via the secret proxy (e.g., ["anthropic", "openai"]).
   * Requires secrets to be configured on the server with `--secret name=value`.
   * The sandbox gets `*_BASE_URL` env vars pointing to a local proxy and
   * placeholder API keys. Real keys never enter the VM.
   */
  secrets?: string[];
}

/** Wire format for POST /sandboxes */
export interface CreateSandboxRequest {
  name: string;
  mounts?: MountSpec[];
  ports?: PortSpec[];
  resources?: {
    cpus?: number;
    memory_mb?: number;
    network?: boolean;
    overlay_gb?: number;
    storage_gb?: number;
    allowed_domains?: string[];
  };
  init_commands?: string[];
  default_user?: string;
  from_starter?: string;
  /** Secret names to inject via the secret proxy. */
  secrets?: string[];
}

/** Merge strategy for combining sandbox filesystems. */
export type MergeStrategy = "theirs" | "ours";

/** Request to merge files from one sandbox into another. */
export interface MergeSandboxRequest {
  strategy?: MergeStrategy;
  files?: string[];
}

/** Result of merging sandbox filesystems. */
export interface MergeResponse {
  source: string;
  target: string;
  merged_files: string[];
  skipped_files: string[];
}

/** Request to clone a sandbox. */
export interface CloneSandboxRequest {
  name: string;
}

/** Result of comparing two sandboxes. */
export interface DiffResult {
  source: string;
  target: string;
  differences: string[];
  identical: boolean;
}

export interface SandboxInfo {
  name: string;
  state: "created" | "stopped" | "running";
  pid?: number;
  mounts: Array<{ tag: string; source: string; target: string; readonly: boolean }>;
  ports: PortSpec[];
  resources: Record<string, unknown>;
  network: boolean;
  restart_count?: number;
}

// ============================================================================
// MicroVM
// ============================================================================

export interface CreateMicroVMOptions {
  cpus?: number;
  memoryMb?: number;
  network?: boolean;
  overlay_gb?: number;
  storage_gb?: number;
  mounts?: MountSpec[];
  ports?: PortSpec[];
}

/** Wire format for POST /microvms — different schema from sandboxes */
export interface CreateMicroVMRequest {
  name: string;
  cpus?: number;
  memoryMb?: number;
  network?: boolean;
  overlay_gb?: number;
  storage_gb?: number;
  mounts?: MountSpec[];
  ports?: PortSpec[];
}

export interface MicroVMInfo {
  name: string;
  state: "created" | "running" | "stopped";
  cpus: number;
  memoryMb: number;
  pid?: number;
  network: boolean;
  mounts: number;
  ports: number;
  created_at: string;
}

// ============================================================================
// Stats
// ============================================================================

export interface ResourceStats {
  name: string;
  state: string;
  pid?: number;
  cpus: number;
  memory_mb: number;
  network: boolean;
  overlay_disk?: DiskStats;
  storage_disk?: DiskStats;
}

export interface DiskStats {
  path: string;
  apparent_size_bytes: number;
  apparent_size_gb: number;
}

// ============================================================================
// Checkpoints
// ============================================================================

export interface CheckpointMetadata {
  id: string;
  source_sandbox: string;
  created_at: string;
  resources: Record<string, unknown>;
  network: boolean;
  overlay_size_bytes: number;
  storage_size_bytes: number;
}

export interface CreateCheckpointResponse {
  id: string;
  source_sandbox: string;
  created_at: string;
  overlay_size_bytes: number;
  storage_size_bytes: number;
}

export interface RestoreCheckpointResponse {
  name: string;
  from_checkpoint: string;
}

// ============================================================================
// Images
// ============================================================================

export interface ImageInfo {
  reference: string;
  digest: string;
  size: number;
  architecture: string;
  os: string;
  layer_count: number;
}

// ============================================================================
// Containers (inside sandbox)
// ============================================================================

export interface CreateContainerOptions {
  image: string;
  command?: string[];
  env?: EnvVar[];
  workdir?: string;
}

export interface ContainerInfo {
  id: string;
  image: string;
  state: "created" | "running" | "stopped";
  command: string[];
  created_at: number;
}

// ============================================================================
// Debug Diagnostics
// ============================================================================

export interface MountInfo {
  tag: string;
  source: string;
  target: string;
  readonly: boolean;
}

export interface DebugMountsResponse {
  configured: MountInfo[];
  guest_mounts: string;
  mnt_listing: string;
  virtiofs_supported: boolean;
}

export interface DebugNetworkResponse {
  configured_ports: PortSpec[];
  listening_ports: string;
  interfaces: string;
  network_enabled: boolean;
}

// ============================================================================
// File API
// ============================================================================

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  permissions: string;
  modified: string;
}

export interface FileReadResponse {
  content: string;
}

export interface FileListResponse {
  directory: string;
  files: FileInfo[];
}

// ============================================================================
// Starters
// ============================================================================

export interface StarterInfo {
  name: string;
  description?: string;
  image?: string;
  tags?: string[];
}

export interface StarterListResponse {
  starters: StarterInfo[];
}

// ============================================================================
// Snapshots
// ============================================================================

export interface SnapshotInfo {
  name: string;
  source_sandbox?: string;
  created_at?: string;
  size_bytes?: number;
}

export interface SnapshotListResponse {
  snapshots: SnapshotInfo[];
}

// ============================================================================
// Jobs (Work Queue)
// ============================================================================

export type JobStatus = "queued" | "running" | "completed" | "failed" | "dead";

export interface SubmitJobRequest {
  sandbox: string;
  command: string[];
  env?: EnvVar[];
  workdir?: string;
  timeout_secs?: number;
  max_retries?: number;
  priority?: number;
  labels?: Record<string, string>;
}

export interface SubmitJobResponse {
  id: string;
  status: JobStatus;
}

export interface JobInfo {
  id: string;
  sandbox: string;
  command: string[];
  env: EnvVar[];
  workdir?: string;
  timeout_secs: number;
  status: JobStatus;
  max_retries: number;
  attempts: number;
  priority: number;
  labels: Record<string, string>;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  result?: ExecResult;
  error?: string;
}

export interface ListJobsResponse {
  jobs: JobInfo[];
}

export interface CompleteJobRequest {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface FailJobRequest {
  error: string;
}
