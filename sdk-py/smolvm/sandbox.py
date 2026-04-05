"""smolvm Python SDK — Sandbox.

High-level stateful wrapper around a single smolvm sandbox.
Provides exec, shell, file I/O, and just-bash-compatible API.
"""

from __future__ import annotations

from base64 import b64decode, b64encode

from .client import SmolvmHttpClient
from .types import CreateCheckpointResponse, DiffResult, ExecOptions, ExecResult, EnvVar, FileInfo, MergeResponse, ResourceStats, SandboxInfo


class Sandbox:
    """Stateful wrapper around a single smolvm sandbox."""

    def __init__(self, name: str, http: SmolvmHttpClient):
        self.name = name
        self._http = http
        self._info: SandboxInfo | None = None

    @property
    def state(self) -> str:
        return self._info.state if self._info else "unknown"

    # --------------------------------------------------------------------------
    # Lifecycle
    # --------------------------------------------------------------------------

    async def start(self) -> None:
        self._info = await self._http.start_sandbox(self.name)

    async def stop(self) -> None:
        self._info = await self._http.stop_sandbox(self.name)

    async def delete(self, force: bool = False) -> None:
        await self._http.delete_sandbox(self.name, force)
        self._info = None

    async def info(self) -> SandboxInfo:
        self._info = await self._http.get_sandbox(self.name)
        return self._info

    async def stats(self) -> ResourceStats:
        return await self._http.sandbox_stats(self.name)

    async def checkpoint(self) -> CreateCheckpointResponse:
        """Create a cold checkpoint. The sandbox must be stopped first."""
        return await self._http.create_checkpoint(self.name)

    async def clone(self, clone_name: str) -> "Sandbox":
        """Clone this sandbox into a new sandbox (instant on macOS APFS)."""
        await self._http.clone_sandbox(self.name, clone_name)
        return Sandbox(clone_name, self._http)

    async def diff(self, other: str) -> DiffResult:
        """Compare this sandbox with another. Lists files that differ."""
        return await self._http.diff_sandboxes(self.name, other)

    async def merge(
        self,
        target: str,
        strategy: str | None = None,
        files: list[str] | None = None,
    ) -> MergeResponse:
        """Merge files from this sandbox into the target sandbox."""
        return await self._http.merge_sandboxes(
            self.name, target, strategy=strategy, files=files
        )

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
        """Execute a command array in the sandbox."""
        return await self._http.exec_sandbox(self.name, command, opts)

    async def sh(
        self, cmd: str, opts: ExecOptions | None = None
    ) -> ExecResult:
        """Execute a shell command string (wraps in sh -c)."""
        return await self.exec(["sh", "-c", cmd], opts)

    async def run_command(
        self, cmd: str, opts: ExecOptions | None = None
    ) -> ExecResult:
        """Execute a shell command. Alias for sh() — just-bash compatible."""
        return await self.sh(cmd, opts)

    # --------------------------------------------------------------------------
    # File I/O (via HTTP file API)
    # --------------------------------------------------------------------------

    async def write_file(
        self, path: str, content: str, permissions: str | None = None
    ) -> None:
        """Write a file to the sandbox filesystem via the file API.

        Content is base64-encoded for transport.

        Args:
            path: Absolute path in the sandbox filesystem.
            content: File content (will be base64-encoded).
            permissions: Optional Unix permissions string (e.g. "0644").
        """
        encoded = b64encode(content.encode()).decode()
        await self._http.write_file(self.name, path, encoded, permissions)

    async def read_file(self, path: str) -> str:
        """Read a file from the sandbox filesystem via the file API.

        Returns decoded content (base64 decoded from API response).
        """
        response = await self._http.read_file(self.name, path)
        return b64decode(response.content).decode()

    async def delete_file(self, path: str) -> None:
        """Delete a file from the sandbox filesystem via the file API."""
        await self._http.delete_file(self.name, path)

    async def write_files(self, files: dict[str, str]) -> None:
        """Write multiple files at once."""
        for path, content in files.items():
            await self.write_file(path, content)

    async def list_files(self, directory: str | None = None) -> list[FileInfo]:
        """List files in a directory via the file API.

        Returns detailed FileInfo objects.
        """
        response = await self._http.list_files(self.name, directory)
        return response.files

    async def exists(self, path: str) -> bool:
        """Check if a file or directory exists."""
        result = await self.sh(f"test -e '{path}' && echo yes || echo no")
        return result.stdout.strip() == "yes"

    async def upload_file(
        self, path: str, data: bytes, permissions: str | None = None
    ) -> dict:
        """Upload a binary file via multipart/form-data.

        No base64 encoding needed — suitable for large files.

        Args:
            path: Absolute path in the sandbox filesystem.
            data: Raw file data as bytes.
            permissions: Optional Unix permissions string (e.g. "0755").
        """
        return await self._http.upload_file(
            self.name, path, data, permissions
        )

    async def upload_archive(
        self, archive: bytes, directory: str | None = None
    ) -> dict:
        """Upload a tar.gz archive and extract it into a directory.

        Args:
            archive: Raw tar.gz bytes.
            directory: Directory to extract to (default: /).
        """
        return await self._http.upload_archive(self.name, archive, directory)

    async def download_archive(self, directory: str | None = None) -> bytes:
        """Download a directory as a tar.gz archive.

        Args:
            directory: Directory to archive (default: /).

        Returns:
            Raw tar.gz bytes.
        """
        return await self._http.download_archive(self.name, directory)

    async def push(self) -> None:
        """Push this sandbox as a snapshot for later retrieval."""
        await self._http.push_sandbox(self.name)
