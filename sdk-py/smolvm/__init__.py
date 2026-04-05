"""smolvm Python SDK — OCI-native microVM runtime.

Thin async wrapper around smolvm's REST API. Matches the TypeScript
SDK's API surface for cross-language consistency.

Example:
    import asyncio
    from smolvm import SmolvmClient

    async def main():
        client = SmolvmClient()
        sandbox = await client.create_and_start("my-vm", network=True)
        result = await sandbox.sh("echo hello")
        print(result.stdout)  # "hello\n"
        await sandbox.cleanup()

    asyncio.run(main())
"""

from .client import SmolvmHttpClient, SmolvmError
from .sandbox import Sandbox
from .microvm import MicroVM
from .fleet import SandboxFleet
from .smolvm_client import SmolvmClient
from .types import (
    CheckpointMetadata,
    CreateCheckpointResponse,
    CreateSandboxOptions,
    CreateMicroVMOptions,
    DiskStats,
    EnvVar,
    ExecOptions,
    ExecResult,
    FileInfo,
    FileListResponse,
    FileReadResponse,
    HealthResponse,
    MicroVMInfo,
    MountSpec,
    PortSpec,
    ResourceStats,
    RestoreCheckpointResponse,
    SandboxInfo,
    SnapshotInfo,
    StarterInfo,
)

__all__ = [
    "SmolvmClient",
    "SmolvmHttpClient",
    "SmolvmError",
    "Sandbox",
    "MicroVM",
    "SandboxFleet",
    "CheckpointMetadata",
    "CreateCheckpointResponse",
    "CreateSandboxOptions",
    "CreateMicroVMOptions",
    "DiskStats",
    "EnvVar",
    "ExecOptions",
    "ExecResult",
    "FileInfo",
    "FileListResponse",
    "FileReadResponse",
    "HealthResponse",
    "MicroVMInfo",
    "MountSpec",
    "PortSpec",
    "ResourceStats",
    "RestoreCheckpointResponse",
    "SandboxInfo",
    "SnapshotInfo",
    "StarterInfo",
]
