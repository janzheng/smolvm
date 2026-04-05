"""smolvm Python SDK — Fleet.

Multi-sandbox orchestration. Creates N sandboxes, executes commands
across all of them in parallel, and cleans up.
"""

from __future__ import annotations

import asyncio
from typing import Any

from .client import SmolvmHttpClient
from .sandbox import Sandbox
from .types import CreateSandboxOptions, ExecOptions, ExecResult


class SandboxFleet:
    """A fleet of sandboxes for parallel execution."""

    def __init__(self, sandboxes: list[Sandbox], http: SmolvmHttpClient):
        self.sandboxes = sandboxes
        self._http = http

    @property
    def size(self) -> int:
        return len(self.sandboxes)

    @property
    def names(self) -> list[str]:
        return [s.name for s in self.sandboxes]

    async def exec_all(
        self, cmd: str, opts: ExecOptions | None = None
    ) -> list[ExecResult]:
        """Execute a shell command across all sandboxes in parallel."""
        return await asyncio.gather(
            *(s.sh(cmd, opts) for s in self.sandboxes)
        )

    async def exec_each(
        self, cmds: list[str], opts: ExecOptions | None = None
    ) -> list[ExecResult]:
        """Execute different commands on each sandbox in parallel."""
        if len(cmds) != len(self.sandboxes):
            raise ValueError(
                f"Expected {len(self.sandboxes)} commands, got {len(cmds)}"
            )
        return await asyncio.gather(
            *(s.sh(cmd, opts) for s, cmd in zip(self.sandboxes, cmds))
        )

    async def exec_all_raw(
        self, command: list[str], opts: ExecOptions | None = None
    ) -> list[ExecResult]:
        """Execute a raw command array across all sandboxes in parallel."""
        return await asyncio.gather(
            *(s.exec(command, opts) for s in self.sandboxes)
        )

    def at(self, index: int) -> Sandbox:
        """Get a specific sandbox by index."""
        if index < 0 or index >= len(self.sandboxes):
            raise IndexError(
                f"Fleet index {index} out of range (size: {self.size})"
            )
        return self.sandboxes[index]

    async def cleanup(self) -> None:
        """Stop and delete all sandboxes. Ignores errors."""
        await asyncio.gather(*(s.cleanup() for s in self.sandboxes))


async def create_fleet(
    http: SmolvmHttpClient,
    prefix: str,
    count: int,
    opts: CreateSandboxOptions | None = None,
) -> SandboxFleet:
    """Create a fleet of sandboxes. Names: {prefix}-0, {prefix}-1, etc."""
    if opts is None:
        opts = CreateSandboxOptions(cpus=1, memory_mb=512, network=True)

    sandboxes: list[Sandbox] = []

    for i in range(count):
        name = f"{prefix}-{i}"

        # Cleanup any leftover from previous runs
        try:
            await http.stop_sandbox(name)
        except Exception:
            pass
        try:
            await http.delete_sandbox(name)
        except Exception:
            pass

        # Create
        req: dict[str, Any] = {
            "name": name,
            "resources": {
                "cpus": opts.cpus,
                "memory_mb": opts.memory_mb,
                "network": opts.network,
            },
        }
        if opts.overlay_gb is not None:
            req["resources"]["overlay_gb"] = opts.overlay_gb
        if opts.storage_gb is not None:
            req["resources"]["storage_gb"] = opts.storage_gb
        if opts.allowed_domains is not None:
            req["resources"]["allowed_domains"] = opts.allowed_domains
        if opts.mounts:
            req["mounts"] = [
                {"source": m.source, "target": m.target, "readonly": m.readonly}
                for m in opts.mounts
            ]
        if opts.ports:
            req["ports"] = [
                {"host": p.host, "guest": p.guest} for p in opts.ports
            ]
        if opts.init_commands is not None:
            req["init_commands"] = opts.init_commands
        if opts.default_user is not None:
            req["default_user"] = opts.default_user
        if opts.from_starter is not None:
            req["from_starter"] = opts.from_starter

        await http.create_sandbox(req)
        sandboxes.append(Sandbox(name, http))

    # Start all in parallel
    await asyncio.gather(*(s.start() for s in sandboxes))

    return SandboxFleet(sandboxes, http)
