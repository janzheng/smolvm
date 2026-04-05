"""smolvm Python SDK — HTTP Client.

Low-level transport layer. Handles all REST API communication.
Users should prefer the high-level Sandbox/MicroVM classes.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from .types import (
    CheckpointMetadata,
    CreateCheckpointResponse,
    DiffResult,
    DiskStats,
    ExecOptions,
    ExecResult,
    FileInfo,
    FileListResponse,
    FileReadResponse,
    HealthResponse,
    JobInfo,
    MergeResponse,
    MicroVMInfo,
    ResourceStats,
    RestoreCheckpointResponse,
    SandboxInfo,
    SnapshotInfo,
    StarterInfo,
    SubmitJobRequest,
)

from urllib.parse import quote as url_quote


class SmolvmError(Exception):
    """Error from the smolvm REST API."""

    def __init__(self, status: int, body: str, message: str | None = None):
        self.status = status
        self.body = body
        super().__init__(message or f"smolvm API error ({status}): {body}")


class SmolvmHttpClient:
    """Low-level async HTTP client for the smolvm REST API."""

    def __init__(self, base_url: str | None = None, api_token: str | None = None):
        self.base_url = (
            base_url or os.environ.get("SMOLVM_URL") or "http://127.0.0.1:9090"
        ).rstrip("/")
        self._api_token = api_token or os.environ.get("SMOLVM_API_TOKEN")
        headers: dict[str, str] = {}
        if self._api_token:
            headers["Authorization"] = f"Bearer {self._api_token}"
        self._client = httpx.AsyncClient(timeout=120.0, headers=headers)

    @property
    def api(self) -> str:
        return f"{self.base_url}/api/v1"

    async def _request(
        self, method: str, path: str, json: Any = None
    ) -> httpx.Response:
        url = path if path.startswith("http") else f"{self.api}{path}"
        return await self._client.request(method, url, json=json)

    async def _json(self, resp: httpx.Response) -> Any:
        if resp.status_code >= 400:
            raise SmolvmError(resp.status_code, resp.text)
        return resp.json()

    async def close(self) -> None:
        await self._client.aclose()

    # --------------------------------------------------------------------------
    # Health
    # --------------------------------------------------------------------------

    async def health(self) -> HealthResponse:
        resp = await self._client.get(f"{self.base_url}/health")
        data = await self._json(resp)
        return HealthResponse(status=data["status"], version=data["version"])

    # --------------------------------------------------------------------------
    # Sandboxes
    # --------------------------------------------------------------------------

    async def create_sandbox(self, req: dict[str, Any]) -> SandboxInfo:
        resp = await self._request("POST", "/sandboxes", json=req)
        data = await self._json(resp)
        return _parse_sandbox_info(data)

    async def get_sandbox(self, name: str) -> SandboxInfo:
        resp = await self._request("GET", f"/sandboxes/{name}")
        data = await self._json(resp)
        return _parse_sandbox_info(data)

    async def list_sandboxes(self) -> list[SandboxInfo]:
        resp = await self._request("GET", "/sandboxes")
        data = await self._json(resp)
        return [_parse_sandbox_info(s) for s in data.get("sandboxes", [])]

    async def sandbox_stats(self, name: str) -> ResourceStats:
        resp = await self._request("GET", f"/sandboxes/{name}/stats")
        data = await self._json(resp)
        return _parse_resource_stats(data)

    async def start_sandbox(self, name: str) -> SandboxInfo:
        resp = await self._request("POST", f"/sandboxes/{name}/start")
        data = await self._json(resp)
        return _parse_sandbox_info(data)

    async def stop_sandbox(self, name: str) -> SandboxInfo:
        resp = await self._request("POST", f"/sandboxes/{name}/stop")
        data = await self._json(resp)
        return _parse_sandbox_info(data)

    async def delete_sandbox(self, name: str, force: bool = False) -> None:
        qs = "?force=true" if force else ""
        resp = await self._request("DELETE", f"/sandboxes/{name}{qs}")
        if resp.status_code >= 400:
            raise SmolvmError(resp.status_code, resp.text)

    async def clone_sandbox(self, source_name: str, clone_name: str) -> SandboxInfo:
        resp = await self._request(
            "POST", f"/sandboxes/{source_name}/clone", json={"name": clone_name}
        )
        data = await self._json(resp)
        return _parse_sandbox_info(data)

    async def diff_sandboxes(self, name: str, other: str) -> DiffResult:
        resp = await self._request("GET", f"/sandboxes/{name}/diff/{other}")
        data = await self._json(resp)
        return DiffResult(
            source=data.get("source", name),
            target=data.get("target", other),
            differences=data.get("differences", []),
            identical=data.get("identical", True),
        )

    async def exec_sandbox(
        self,
        name: str,
        command: list[str],
        opts: ExecOptions | None = None,
    ) -> ExecResult:
        body: dict[str, Any] = {
            "command": command,
            "timeout_secs": (opts.timeout_secs if opts else None) or 30,
        }
        if opts and opts.env:
            body["env"] = [{"name": e.name, "value": e.value} for e in opts.env]
        if opts and opts.workdir:
            body["workdir"] = opts.workdir
        if opts and opts.user:
            body["user"] = opts.user
        resp = await self._request("POST", f"/sandboxes/{name}/exec", json=body)
        data = await self._json(resp)
        return ExecResult(
            exit_code=data["exit_code"],
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
        )

    async def merge_sandboxes(
        self,
        source_name: str,
        target_name: str,
        strategy: str | None = None,
        files: list[str] | None = None,
    ) -> MergeResponse:
        body: dict[str, Any] = {}
        if strategy is not None:
            body["strategy"] = strategy
        if files is not None:
            body["files"] = files
        resp = await self._request(
            "POST", f"/sandboxes/{source_name}/merge/{target_name}", json=body
        )
        data = await self._json(resp)
        return MergeResponse(
            source=data.get("source", source_name),
            target=data.get("target", target_name),
            merged_files=data.get("merged_files", []),
            skipped_files=data.get("skipped_files", []),
        )

    # --------------------------------------------------------------------------
    # File API
    # --------------------------------------------------------------------------

    async def read_file(self, sandbox_name: str, path: str) -> FileReadResponse:
        encoded_path = url_quote(path, safe="")
        resp = await self._request(
            "GET", f"/sandboxes/{sandbox_name}/files/{encoded_path}"
        )
        data = await self._json(resp)
        return FileReadResponse(content=data["content"])

    async def write_file(
        self,
        sandbox_name: str,
        path: str,
        content: str,
        permissions: str | None = None,
    ) -> None:
        encoded_path = url_quote(path, safe="")
        body: dict[str, Any] = {"content": content}
        if permissions is not None:
            body["permissions"] = permissions
        resp = await self._request(
            "PUT", f"/sandboxes/{sandbox_name}/files/{encoded_path}", json=body
        )
        if resp.status_code >= 400:
            raise SmolvmError(resp.status_code, resp.text)

    async def delete_file(self, sandbox_name: str, path: str) -> None:
        encoded_path = url_quote(path, safe="")
        resp = await self._request(
            "DELETE", f"/sandboxes/{sandbox_name}/files/{encoded_path}"
        )
        if resp.status_code >= 400:
            raise SmolvmError(resp.status_code, resp.text)

    async def list_files(
        self, sandbox_name: str, directory: str | None = None
    ) -> FileListResponse:
        qs = f"?dir={url_quote(directory, safe='')}" if directory else ""
        resp = await self._request(
            "GET", f"/sandboxes/{sandbox_name}/files{qs}"
        )
        data = await self._json(resp)
        files = [
            FileInfo(
                name=f["name"],
                path=f["path"],
                size=f.get("size", 0),
                is_dir=f.get("is_dir", False),
                permissions=f.get("permissions", ""),
                modified=f.get("modified", ""),
            )
            for f in data.get("files", [])
        ]
        return FileListResponse(
            directory=data.get("directory", directory or "/"),
            files=files,
        )

    # --------------------------------------------------------------------------
    # Multipart Upload & Archive
    # --------------------------------------------------------------------------

    async def upload_file(
        self,
        sandbox_name: str,
        path: str,
        data: bytes,
        permissions: str | None = None,
    ) -> dict[str, Any]:
        """Upload a file via multipart/form-data (no base64 encoding needed)."""
        encoded_path = url_quote(path, safe="")
        files = {"file": ("upload", data)}
        form_data: dict[str, str] = {}
        if permissions is not None:
            form_data["permissions"] = permissions
        resp = await self._client.post(
            f"{self.api}/sandboxes/{sandbox_name}/upload/{encoded_path}",
            files=files,
            data=form_data if form_data else None,
        )
        return await self._json(resp)

    async def upload_archive(
        self,
        sandbox_name: str,
        archive: bytes,
        directory: str | None = None,
    ) -> dict[str, Any]:
        """Upload a tar.gz archive and extract it into a sandbox directory."""
        qs = f"?dir={url_quote(directory, safe='')}" if directory else ""
        resp = await self._client.post(
            f"{self.api}/sandboxes/{sandbox_name}/archive/upload{qs}",
            content=archive,
            headers={"Content-Type": "application/gzip"},
        )
        return await self._json(resp)

    async def download_archive(
        self,
        sandbox_name: str,
        directory: str | None = None,
    ) -> bytes:
        """Download a sandbox directory as a tar.gz archive."""
        qs = f"?dir={url_quote(directory, safe='')}" if directory else ""
        resp = await self._client.get(
            f"{self.api}/sandboxes/{sandbox_name}/archive{qs}"
        )
        if resp.status_code >= 400:
            raise SmolvmError(resp.status_code, resp.text)
        return resp.content

    # --------------------------------------------------------------------------
    # Starters
    # --------------------------------------------------------------------------

    async def list_starters(self) -> list[StarterInfo]:
        resp = await self._request("GET", "/starters")
        data = await self._json(resp)
        return [
            StarterInfo(
                name=s["name"],
                description=s.get("description"),
                image=s.get("image"),
                tags=s.get("tags"),
            )
            for s in data.get("starters", [])
        ]

    # --------------------------------------------------------------------------
    # Snapshots (push/pull)
    # --------------------------------------------------------------------------

    async def push_sandbox(self, sandbox_name: str) -> None:
        resp = await self._request("POST", f"/sandboxes/{sandbox_name}/push")
        if resp.status_code >= 400:
            raise SmolvmError(resp.status_code, resp.text)

    async def list_snapshots(self) -> list[SnapshotInfo]:
        resp = await self._request("GET", "/snapshots")
        data = await self._json(resp)
        return [
            SnapshotInfo(
                name=s["name"],
                source_sandbox=s.get("source_sandbox"),
                created_at=s.get("created_at"),
                size_bytes=s.get("size_bytes"),
            )
            for s in data.get("snapshots", [])
        ]

    async def pull_snapshot(
        self, snapshot_name: str, sandbox_name: str
    ) -> SandboxInfo:
        resp = await self._request(
            "POST",
            f"/snapshots/{snapshot_name}/pull",
            json={"name": sandbox_name},
        )
        data = await self._json(resp)
        return _parse_sandbox_info(data)

    async def delete_snapshot(self, name: str) -> None:
        resp = await self._request("DELETE", f"/snapshots/{name}")
        if resp.status_code >= 400:
            raise SmolvmError(resp.status_code, resp.text)

    # --------------------------------------------------------------------------
    # Checkpoints
    # --------------------------------------------------------------------------

    async def create_checkpoint(self, sandbox_name: str) -> CreateCheckpointResponse:
        resp = await self._request("POST", f"/sandboxes/{sandbox_name}/checkpoint")
        data = await self._json(resp)
        return CreateCheckpointResponse(
            id=data["id"],
            source_sandbox=data["source_sandbox"],
            created_at=data["created_at"],
            overlay_size_bytes=data["overlay_size_bytes"],
            storage_size_bytes=data["storage_size_bytes"],
        )

    async def list_checkpoints(self) -> list[CheckpointMetadata]:
        resp = await self._request("GET", "/checkpoints")
        data = await self._json(resp)
        return [
            CheckpointMetadata(
                id=c["id"],
                source_sandbox=c["source_sandbox"],
                created_at=c["created_at"],
                resources=c.get("resources", {}),
                network=c.get("network", False),
                overlay_size_bytes=c["overlay_size_bytes"],
                storage_size_bytes=c["storage_size_bytes"],
            )
            for c in data.get("checkpoints", [])
        ]

    async def restore_checkpoint(
        self, checkpoint_id: str, name: str
    ) -> RestoreCheckpointResponse:
        resp = await self._request(
            "POST", f"/checkpoints/{checkpoint_id}/restore", json={"name": name}
        )
        data = await self._json(resp)
        return RestoreCheckpointResponse(
            name=data["name"],
            from_checkpoint=data["from_checkpoint"],
        )

    async def delete_checkpoint(self, checkpoint_id: str) -> None:
        resp = await self._request("DELETE", f"/checkpoints/{checkpoint_id}")
        if resp.status_code >= 400:
            raise SmolvmError(resp.status_code, resp.text)

    # --------------------------------------------------------------------------
    # MicroVMs
    # --------------------------------------------------------------------------

    async def create_microvm(self, req: dict[str, Any]) -> MicroVMInfo:
        resp = await self._request("POST", "/microvms", json=req)
        data = await self._json(resp)
        return _parse_microvm_info(data)

    async def get_microvm(self, name: str) -> MicroVMInfo:
        resp = await self._request("GET", f"/microvms/{name}")
        data = await self._json(resp)
        return _parse_microvm_info(data)

    async def list_microvms(self) -> list[MicroVMInfo]:
        resp = await self._request("GET", "/microvms")
        data = await self._json(resp)
        return [_parse_microvm_info(m) for m in data.get("microvms", [])]

    async def start_microvm(self, name: str) -> MicroVMInfo:
        resp = await self._request("POST", f"/microvms/{name}/start")
        data = await self._json(resp)
        return _parse_microvm_info(data)

    async def stop_microvm(self, name: str) -> MicroVMInfo:
        resp = await self._request("POST", f"/microvms/{name}/stop")
        data = await self._json(resp)
        return _parse_microvm_info(data)

    async def delete_microvm(self, name: str, force: bool = False) -> None:
        qs = "?force=true" if force else ""
        resp = await self._request("DELETE", f"/microvms/{name}{qs}")
        if resp.status_code >= 400:
            raise SmolvmError(resp.status_code, resp.text)

    async def exec_microvm(
        self,
        name: str,
        command: list[str],
        opts: ExecOptions | None = None,
    ) -> ExecResult:
        body: dict[str, Any] = {
            "command": command,
            "timeout_secs": (opts.timeout_secs if opts else None) or 30,
        }
        if opts and opts.env:
            body["env"] = [{"name": e.name, "value": e.value} for e in opts.env]
        if opts and opts.workdir:
            body["workdir"] = opts.workdir
        resp = await self._request("POST", f"/microvms/{name}/exec", json=body)
        data = await self._json(resp)
        return ExecResult(
            exit_code=data["exit_code"],
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
        )

    # --------------------------------------------------------------------------
    # Jobs (Work Queue)
    # --------------------------------------------------------------------------

    async def submit_job(self, req: SubmitJobRequest) -> dict[str, Any]:
        body: dict[str, Any] = {
            "sandbox": req.sandbox,
            "command": req.command,
            "env": [{"name": e.name, "value": e.value} for e in (req.env or [])],
            "priority": req.priority,
            "labels": req.labels or {},
        }
        if req.workdir is not None:
            body["workdir"] = req.workdir
        if req.timeout_secs is not None:
            body["timeout_secs"] = req.timeout_secs
        if req.max_retries is not None:
            body["max_retries"] = req.max_retries
        resp = await self._request("POST", "/jobs", json=body)
        return await self._json(resp)

    async def list_jobs(
        self,
        status: str | None = None,
        sandbox: str | None = None,
        limit: int | None = None,
    ) -> list[JobInfo]:
        params: list[str] = []
        if status:
            params.append(f"status={url_quote(status, safe='')}")
        if sandbox:
            params.append(f"sandbox={url_quote(sandbox, safe='')}")
        if limit is not None:
            params.append(f"limit={limit}")
        qs = f"?{'&'.join(params)}" if params else ""
        resp = await self._request("GET", f"/jobs{qs}")
        data = await self._json(resp)
        return [_parse_job_info(j) for j in data.get("jobs", [])]

    async def get_job(self, job_id: str) -> JobInfo:
        resp = await self._request("GET", f"/jobs/{job_id}")
        data = await self._json(resp)
        return _parse_job_info(data)

    async def poll_job(self) -> JobInfo | None:
        resp = await self._request("POST", "/jobs/poll")
        if resp.status_code == 204:
            return None
        data = await self._json(resp)
        return _parse_job_info(data)

    async def complete_job(
        self, job_id: str, exit_code: int, stdout: str, stderr: str
    ) -> JobInfo:
        resp = await self._request(
            "POST",
            f"/jobs/{job_id}/complete",
            json={"exit_code": exit_code, "stdout": stdout, "stderr": stderr},
        )
        data = await self._json(resp)
        return _parse_job_info(data)

    async def fail_job(self, job_id: str, error: str) -> JobInfo:
        resp = await self._request(
            "POST", f"/jobs/{job_id}/fail", json={"error": error}
        )
        data = await self._json(resp)
        return _parse_job_info(data)

    async def delete_job(self, job_id: str) -> None:
        resp = await self._request("DELETE", f"/jobs/{job_id}")
        if resp.status_code >= 400:
            raise SmolvmError(resp.status_code, resp.text)


# ============================================================================
# Parsers
# ============================================================================


def _parse_sandbox_info(data: dict[str, Any]) -> SandboxInfo:
    return SandboxInfo(
        name=data["name"],
        state=data.get("state", "unknown"),
        pid=data.get("pid"),
        mounts=data.get("mounts", []),
        ports=data.get("ports", []),
        resources=data.get("resources", {}),
        network=data.get("network", False),
        restart_count=data.get("restart_count"),
    )


def _parse_microvm_info(data: dict[str, Any]) -> MicroVMInfo:
    return MicroVMInfo(
        name=data["name"],
        state=data.get("state", "unknown"),
        cpus=data.get("cpus", 2),
        memoryMb=data.get("memoryMb", 1024),
        pid=data.get("pid"),
        network=data.get("network", False),
        mounts=data.get("mounts", 0),
        ports=data.get("ports", 0),
        created_at=data.get("created_at", ""),
    )


def _parse_disk_stats(data: dict[str, Any]) -> DiskStats:
    return DiskStats(
        path=data["path"],
        apparent_size_bytes=data["apparent_size_bytes"],
        apparent_size_gb=data["apparent_size_gb"],
    )


def _parse_resource_stats(data: dict[str, Any]) -> ResourceStats:
    return ResourceStats(
        name=data["name"],
        state=data["state"],
        cpus=data["cpus"],
        memory_mb=data["memory_mb"],
        network=data["network"],
        pid=data.get("pid"),
        overlay_disk=(
            _parse_disk_stats(data["overlay_disk"])
            if data.get("overlay_disk")
            else None
        ),
        storage_disk=(
            _parse_disk_stats(data["storage_disk"])
            if data.get("storage_disk")
            else None
        ),
    )


def _parse_job_info(data: dict[str, Any]) -> JobInfo:
    result = None
    if data.get("result"):
        r = data["result"]
        result = ExecResult(
            exit_code=r["exit_code"],
            stdout=r.get("stdout", ""),
            stderr=r.get("stderr", ""),
        )
    return JobInfo(
        id=data["id"],
        sandbox=data["sandbox"],
        command=data["command"],
        status=data["status"],
        timeout_secs=data.get("timeout_secs", 300),
        max_retries=data.get("max_retries", 0),
        attempts=data.get("attempts", 0),
        priority=data.get("priority", 0),
        created_at=data.get("created_at", 0),
        started_at=data.get("started_at"),
        completed_at=data.get("completed_at"),
        result=result,
        error=data.get("error"),
        labels=data.get("labels"),
    )
