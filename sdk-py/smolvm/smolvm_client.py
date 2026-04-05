"""smolvm Python SDK — SmolvmClient.

Top-level client. The main entry point for the SDK.
Creates sandboxes, microvms, and fleets.
"""

from __future__ import annotations

from typing import Any

from .client import SmolvmHttpClient
from .sandbox import Sandbox
from .microvm import MicroVM
from .fleet import SandboxFleet, create_fleet
from .types import (
    CheckpointMetadata,
    CreateMicroVMOptions,
    CreateSandboxOptions,
    HealthResponse,
    MicroVMInfo,
    SandboxInfo,
    SnapshotInfo,
    StarterInfo,
)


class SmolvmClient:
    """Top-level smolvm client.

    Args:
        base_url: smolvm server URL. Defaults to SMOLVM_URL env var
                  or http://127.0.0.1:8080.
        api_token: Bearer token for authentication. Defaults to
                   SMOLVM_API_TOKEN env var.
    """

    def __init__(self, base_url: str | None = None, api_token: str | None = None):
        self._http = SmolvmHttpClient(base_url, api_token=api_token)

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._http.close()

    # --------------------------------------------------------------------------
    # Health
    # --------------------------------------------------------------------------

    async def health(self) -> HealthResponse:
        return await self._http.health()

    # --------------------------------------------------------------------------
    # Sandboxes
    # --------------------------------------------------------------------------

    async def create(
        self,
        name: str,
        cpus: int = 2,
        memory_mb: int = 1024,
        network: bool = False,
        overlay_gb: int | None = None,
        storage_gb: int | None = None,
        mounts: list[Any] | None = None,
        ports: list[Any] | None = None,
        init_commands: list[str] | None = None,
        allowed_domains: list[str] | None = None,
        default_user: str | None = None,
        from_starter: str | None = None,
        secrets: list[str] | None = None,
    ) -> Sandbox:
        """Create a new sandbox (ephemeral VM). Does NOT start it.

        Args:
            secrets: Secret names to inject via the secret proxy
                     (e.g., ["anthropic", "openai"]). Requires secrets
                     configured on the server with ``--secret name=value``.
                     The sandbox gets ``*_BASE_URL`` env vars pointing to a
                     local proxy and placeholder API keys. Real keys never
                     enter the VM.
        """
        req: dict[str, Any] = {
            "name": name,
            "resources": {
                "cpus": cpus,
                "memory_mb": memory_mb,
                "network": network,
            },
        }
        if overlay_gb is not None:
            req["resources"]["overlay_gb"] = overlay_gb
        if storage_gb is not None:
            req["resources"]["storage_gb"] = storage_gb
        if allowed_domains is not None:
            req["resources"]["allowed_domains"] = allowed_domains
        if mounts is not None:
            req["mounts"] = mounts
        if ports is not None:
            req["ports"] = ports
        if init_commands is not None:
            req["init_commands"] = init_commands
        if default_user is not None:
            req["default_user"] = default_user
        if from_starter is not None:
            req["from_starter"] = from_starter
        if secrets is not None:
            req["secrets"] = secrets

        await self._http.create_sandbox(req)
        return Sandbox(name, self._http)

    async def create_and_start(
        self,
        name: str,
        cpus: int = 2,
        memory_mb: int = 1024,
        network: bool = False,
        overlay_gb: int | None = None,
        storage_gb: int | None = None,
        mounts: list[Any] | None = None,
        ports: list[Any] | None = None,
        init_commands: list[str] | None = None,
        allowed_domains: list[str] | None = None,
        default_user: str | None = None,
        from_starter: str | None = None,
        secrets: list[str] | None = None,
    ) -> Sandbox:
        """Create and immediately start a sandbox."""
        sandbox = await self.create(
            name,
            cpus=cpus,
            memory_mb=memory_mb,
            network=network,
            overlay_gb=overlay_gb,
            storage_gb=storage_gb,
            mounts=mounts,
            ports=ports,
            init_commands=init_commands,
            allowed_domains=allowed_domains,
            default_user=default_user,
            from_starter=from_starter,
            secrets=secrets,
        )
        await sandbox.start()
        return sandbox

    async def get(self, name: str) -> Sandbox:
        """Get an existing sandbox by name."""
        await self._http.get_sandbox(name)
        return Sandbox(name, self._http)

    async def list(self) -> list[SandboxInfo]:
        return await self._http.list_sandboxes()

    # --------------------------------------------------------------------------
    # Checkpoints
    # --------------------------------------------------------------------------

    async def list_checkpoints(self) -> list[CheckpointMetadata]:
        return await self._http.list_checkpoints()

    async def restore_checkpoint(self, checkpoint_id: str, name: str) -> Sandbox:
        """Restore a checkpoint into a new sandbox."""
        await self._http.restore_checkpoint(checkpoint_id, name)
        return Sandbox(name, self._http)

    async def delete_checkpoint(self, checkpoint_id: str) -> None:
        await self._http.delete_checkpoint(checkpoint_id)

    # --------------------------------------------------------------------------
    # Starters
    # --------------------------------------------------------------------------

    async def list_starters(self) -> list[StarterInfo]:
        """List available starter templates."""
        return await self._http.list_starters()

    # --------------------------------------------------------------------------
    # Snapshots
    # --------------------------------------------------------------------------

    async def list_snapshots(self) -> list[SnapshotInfo]:
        """List available snapshots."""
        return await self._http.list_snapshots()

    async def pull_snapshot(self, snapshot_name: str, sandbox_name: str) -> Sandbox:
        """Pull a snapshot into a new sandbox."""
        await self._http.pull_snapshot(snapshot_name, sandbox_name)
        return Sandbox(sandbox_name, self._http)

    async def delete_snapshot(self, name: str) -> None:
        """Delete a snapshot."""
        await self._http.delete_snapshot(name)

    # --------------------------------------------------------------------------
    # MicroVMs
    # --------------------------------------------------------------------------

    async def create_microvm(
        self,
        name: str,
        cpus: int = 2,
        memory_mb: int = 1024,
        network: bool = False,
        overlay_gb: int | None = None,
        storage_gb: int | None = None,
        mounts: list[Any] | None = None,
        ports: list[Any] | None = None,
    ) -> MicroVM:
        """Create a new MicroVM (persistent VM)."""
        req: dict[str, Any] = {
            "name": name,
            "cpus": cpus,
            "memoryMb": memory_mb,
            "network": network,
        }
        if overlay_gb is not None:
            req["overlay_gb"] = overlay_gb
        if storage_gb is not None:
            req["storage_gb"] = storage_gb
        if mounts is not None:
            req["mounts"] = mounts
        if ports is not None:
            req["ports"] = ports

        await self._http.create_microvm(req)
        return MicroVM(name, self._http)

    async def get_microvm(self, name: str) -> MicroVM:
        await self._http.get_microvm(name)
        return MicroVM(name, self._http)

    async def list_microvms(self) -> list[MicroVMInfo]:
        return await self._http.list_microvms()

    # --------------------------------------------------------------------------
    # Fleet
    # --------------------------------------------------------------------------

    async def create_fleet(
        self,
        prefix: str,
        count: int,
        cpus: int = 1,
        memory_mb: int = 512,
        network: bool = True,
        overlay_gb: int | None = None,
        storage_gb: int | None = None,
    ) -> SandboxFleet:
        """Create a fleet of sandboxes. All are created and started."""
        opts = CreateSandboxOptions(
            cpus=cpus,
            memory_mb=memory_mb,
            network=network,
            overlay_gb=overlay_gb,
            storage_gb=storage_gb,
        )
        return await create_fleet(self._http, prefix, count, opts)
