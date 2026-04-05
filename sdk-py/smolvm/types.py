"""smolvm Python SDK — Type Definitions.

Mirrors the TypeScript SDK types. Uses dataclasses for structured responses
and TypedDicts for request options.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ============================================================================
# Shared
# ============================================================================


@dataclass
class ExecResult:
    exit_code: int
    stdout: str
    stderr: str


@dataclass
class ExecOptions:
    env: list[EnvVar] | None = None
    workdir: str | None = None
    timeout_secs: int | None = None
    user: str | None = None


@dataclass
class EnvVar:
    name: str
    value: str


@dataclass
class MountSpec:
    source: str
    target: str
    readonly: bool = False


@dataclass
class PortSpec:
    host: int
    guest: int


@dataclass
class HealthResponse:
    status: str
    version: str


# ============================================================================
# Sandbox
# ============================================================================


@dataclass
class CreateSandboxOptions:
    cpus: int = 2
    memory_mb: int = 1024
    network: bool = False
    overlay_gb: int | None = None
    storage_gb: int | None = None
    mounts: list[MountSpec] | None = None
    ports: list[PortSpec] | None = None
    init_commands: list[str] | None = None
    allowed_domains: list[str] | None = None
    default_user: str | None = None
    from_starter: str | None = None
    secrets: list[str] | None = None


@dataclass
class MergeResponse:
    source: str
    target: str
    merged_files: list[str]
    skipped_files: list[str]


@dataclass
class DiffResult:
    source: str
    target: str
    differences: list[str]
    identical: bool


@dataclass
class SandboxInfo:
    name: str
    state: str
    pid: int | None = None
    mounts: list[dict[str, Any]] = field(default_factory=list)
    ports: list[dict[str, Any]] = field(default_factory=list)
    resources: dict[str, Any] = field(default_factory=dict)
    network: bool = False
    restart_count: int | None = None


# ============================================================================
# MicroVM
# ============================================================================


@dataclass
class CreateMicroVMOptions:
    cpus: int = 2
    memory_mb: int = 1024
    network: bool = False
    overlay_gb: int | None = None
    storage_gb: int | None = None
    mounts: list[MountSpec] | None = None
    ports: list[PortSpec] | None = None


@dataclass
class MicroVMInfo:
    name: str
    state: str
    cpus: int = 2
    memoryMb: int = 1024
    pid: int | None = None
    network: bool = False
    mounts: int = 0
    ports: int = 0
    created_at: str = ""


# ============================================================================
# Stats
# ============================================================================


@dataclass
class DiskStats:
    path: str
    apparent_size_bytes: int
    apparent_size_gb: float


@dataclass
class ResourceStats:
    name: str
    state: str
    cpus: int
    memory_mb: int
    network: bool
    pid: int | None = None
    overlay_disk: DiskStats | None = None
    storage_disk: DiskStats | None = None


# ============================================================================
# Checkpoints
# ============================================================================


@dataclass
class CheckpointMetadata:
    id: str
    source_sandbox: str
    created_at: str
    resources: dict[str, Any]
    network: bool
    overlay_size_bytes: int
    storage_size_bytes: int


@dataclass
class CreateCheckpointResponse:
    id: str
    source_sandbox: str
    created_at: str
    overlay_size_bytes: int
    storage_size_bytes: int


@dataclass
class RestoreCheckpointResponse:
    name: str
    from_checkpoint: str


# ============================================================================
# File API
# ============================================================================


@dataclass
class FileInfo:
    name: str
    path: str
    size: int
    is_dir: bool
    permissions: str
    modified: str


@dataclass
class FileReadResponse:
    content: str


@dataclass
class FileListResponse:
    directory: str
    files: list[FileInfo]


# ============================================================================
# Starters
# ============================================================================


@dataclass
class StarterInfo:
    name: str
    description: str | None = None
    image: str | None = None
    tags: list[str] | None = None


# ============================================================================
# Snapshots
# ============================================================================


@dataclass
class SnapshotInfo:
    name: str
    source_sandbox: str | None = None
    created_at: str | None = None
    size_bytes: int | None = None


# ============================================================================
# Jobs (Work Queue)
# ============================================================================


@dataclass
class SubmitJobRequest:
    sandbox: str
    command: list[str]
    env: list[EnvVar] | None = None
    workdir: str | None = None
    timeout_secs: int | None = None
    max_retries: int | None = None
    priority: int = 0
    labels: dict[str, str] | None = None


@dataclass
class JobInfo:
    id: str
    sandbox: str
    command: list[str]
    status: str
    timeout_secs: int = 300
    max_retries: int = 0
    attempts: int = 0
    priority: int = 0
    created_at: int = 0
    env: list[EnvVar] | None = None
    workdir: str | None = None
    labels: dict[str, str] | None = None
    started_at: int | None = None
    completed_at: int | None = None
    result: ExecResult | None = None
    error: str | None = None
