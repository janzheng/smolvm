"""smolvm Python SDK — MicroVM.

High-level wrapper for persistent MicroVMs.
MicroVMs differ from Sandboxes: different REST schema, persistent by design,
no image/container management.
"""

from __future__ import annotations

from base64 import b64decode, b64encode

from .client import SmolvmHttpClient
from .types import ExecOptions, ExecResult, MicroVMInfo


class MicroVM:
    """Stateful wrapper around a single smolvm MicroVM."""

    def __init__(self, name: str, http: SmolvmHttpClient):
        self.name = name
        self._http = http
        self._info: MicroVMInfo | None = None

    @property
    def state(self) -> str:
        return self._info.state if self._info else "unknown"

    # --------------------------------------------------------------------------
    # Lifecycle
    # --------------------------------------------------------------------------

    async def start(self) -> None:
        self._info = await self._http.start_microvm(self.name)

    async def stop(self) -> None:
        self._info = await self._http.stop_microvm(self.name)

    async def delete(self, force: bool = False) -> None:
        await self._http.delete_microvm(self.name, force)
        self._info = None

    async def info(self) -> MicroVMInfo:
        self._info = await self._http.get_microvm(self.name)
        return self._info

    async def cleanup(self) -> None:
        """Stop + delete. Ignores errors (safe for cleanup)."""
        try:
            await self.stop()
        except Exception:
            pass
        try:
            await self.delete()
        except Exception:
            pass

    # --------------------------------------------------------------------------
    # Execution
    # --------------------------------------------------------------------------

    async def exec(
        self, command: list[str], opts: ExecOptions | None = None
    ) -> ExecResult:
        return await self._http.exec_microvm(self.name, command, opts)

    async def sh(
        self, cmd: str, opts: ExecOptions | None = None
    ) -> ExecResult:
        return await self.exec(["sh", "-c", cmd], opts)

    async def run_command(
        self, cmd: str, opts: ExecOptions | None = None
    ) -> ExecResult:
        return await self.sh(cmd, opts)

    # --------------------------------------------------------------------------
    # File I/O (via exec channel)
    # --------------------------------------------------------------------------

    async def write_file(self, path: str, content: str) -> None:
        encoded = b64encode(content.encode()).decode()
        last_slash = path.rfind("/")
        if last_slash > 0:
            await self.sh(f"mkdir -p '{path[:last_slash]}'")
        result = await self.sh(f"echo '{encoded}' | base64 -d > '{path}'")
        if result.exit_code != 0:
            raise RuntimeError(f"write_file failed: {result.stderr}")

    async def read_file(self, path: str) -> str:
        result = await self.sh(f"base64 '{path}'")
        if result.exit_code != 0:
            raise RuntimeError(f"read_file failed: {result.stderr}")
        return b64decode(result.stdout.strip()).decode()

    async def write_files(self, files: dict[str, str]) -> None:
        for path, content in files.items():
            await self.write_file(path, content)
