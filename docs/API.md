# smolvm API Reference

Base URL: `http://localhost:8080` (default when running `smolvm serve start`)

Swagger UI available at `/swagger-ui` when the server is running.

---

## Health & Metrics

### `GET /health`
Returns server status and version.

### `GET /metrics`
Prometheus-format metrics (VM count, boot times, exec latency, disk usage).

---

## Machinees

Machinees are lightweight VMs with an overlay filesystem.

### `POST /api/v1/machines`
Create a new machine.

```json
{
  "name": "my-machine",
  "resources": {
    "cpus": 2,
    "memoryMb": 1024,
    "network": true,
    "storageGb": 20,
    "overlayGb": 2,
    "allowedDomains": ["api.anthropic.com"]
  },
  "init_commands": ["apk add nodejs npm"],
  "default_user": "agent",
  "from_starter": "claude-code"
}
```

All fields except `name` are optional. `from_starter` pulls a pre-built image
and applies its defaults (see Starters below).

### `GET /api/v1/machines`
List all machinees.

### `GET /api/v1/machines/:id`
Get machine details (state, pid, mounts, ports, resources).

### `POST /api/v1/machines/:id/start`
Start a stopped machine.

### `POST /api/v1/machines/:id/stop`
Stop a running machine.

### `DELETE /api/v1/machines/:id`
Delete a machine. Query param `?force=true` to force-delete.

---

## Execution

### `POST /api/v1/machines/:id/exec`
Run a command synchronously.

```json
{
  "command": ["echo", "hello"],
  "env": [{"name": "MY_VAR", "value": "val"}],
  "workdir": "/workspace",
  "timeoutSecs": 30,
  "user": "agent"
}
```

Response:
```json
{
  "exitCode": 0,
  "stdout": "hello\n",
  "stderr": ""
}
```

### `POST /api/v1/machines/:id/run`
Run a command in a temporary OCI container (one-shot).

```json
{
  "image": "python:3.12-alpine",
  "command": ["python", "-c", "print('hello')"],
  "user": "agent"
}
```

### `GET /api/v1/machines/:id/logs?follow=true&tail=100`
Stream machine logs (SSE). `follow=true` for tail-like behavior.

### `GET /api/v1/machines/:id/exec/stream`
WebSocket streaming exec for long-running commands.

---

## Files

### `GET /api/v1/machines/:id/files?dir=/workspace`
List files in a directory.

### `GET /api/v1/machines/:id/files/*path`
Read a file (returns base64-encoded content).

### `PUT /api/v1/machines/:id/files/*path`
Write a file.

```json
{
  "content": "<base64-encoded>",
  "permissions": "0755"
}
```

### `DELETE /api/v1/machines/:id/files/*path`
Delete a file.

### `POST /api/v1/machines/:id/upload/*path`
Multipart file upload.

### `POST /api/v1/machines/:id/archive/upload`
Upload a tar.gz archive and extract it.

### `GET /api/v1/machines/:id/archive`
Download machine filesystem as tar.gz.

---

## Clone / Diff / Merge

### `POST /api/v1/machines/:id/clone`
Fork a machine's filesystem.

```json
{ "name": "my-machine-fork" }
```

### `GET /api/v1/machines/:id/diff/:other`
Compare two machinees. Returns `{ differences: [...], identical: bool }`.

### `POST /api/v1/machines/:id/merge/:target`
Merge files from source into target.

```json
{
  "strategy": "theirs",
  "files": ["/app/main.ts"]
}
```

Strategies: `theirs` (source wins, default), `ours` (skip existing).

---

## Snapshots (Push/Pull)

### `POST /api/v1/machines/:id/push`
Export machine state as a snapshot archive.

### `GET /api/v1/snapshots`
List available snapshots.

### `POST /api/v1/snapshots/:name/pull`
Restore a snapshot into a new machine.

```json
{ "name": "my-restored-machine" }
```

### `DELETE /api/v1/snapshots/:name`
Delete a snapshot.

---

## Containers

Run OCI containers inside a machine.

### `POST /api/v1/machines/:id/containers`
```json
{
  "image": "alpine:latest",
  "command": ["sleep", "infinity"],
  "mounts": [{"source": "smolvm0", "target": "/app"}]
}
```

Mount `source` is a virtiofs tag — check `GET /machines/:id` for tag mappings.

### `GET /api/v1/machines/:id/containers`
### `POST /api/v1/machines/:id/containers/:cid/start`
### `POST /api/v1/machines/:id/containers/:cid/stop`
### `DELETE /api/v1/machines/:id/containers/:cid`
### `POST /api/v1/machines/:id/containers/:cid/exec`

---

## Images

### `GET /api/v1/machines/:id/images`
List pulled OCI images in a machine.

### `POST /api/v1/machines/:id/images/pull`
```json
{
  "image": "python:3.12-alpine",
  "ociPlatform": "linux/arm64"
}
```

---

## MicroVMs

Persistent VMs with more control (separate from machinees).

### `POST /api/v1/microvms`
```json
{
  "name": "my-vm",
  "cpus": 2,
  "memoryMb": 1024,
  "network": true,
  "storageGb": 20,
  "overlayGb": 2
}
```

### `GET /api/v1/microvms`
### `GET /api/v1/microvms/:name`
### `POST /api/v1/microvms/:name/start`
### `POST /api/v1/microvms/:name/stop`
### `DELETE /api/v1/microvms/:name`
### `POST /api/v1/microvms/:name/exec`

---

## Starters

### `GET /api/v1/starters`
List available starter images.

Built-in starters:

| Name | Includes |
|------|----------|
| `claude-code` | Node.js, npm, Python 3, git, openssh, curl, Claude Code CLI |
| `node` | Node.js, npm, git, curl |
| `python-ml` | Python 3, pip, numpy |
| `universal` | Node.js, npm, Python 3, pip, git, curl, Go, Rust, Claude Code CLI |

Use `from_starter` in machine creation to bootstrap from one.

---

## Debug

### `GET /api/v1/machines/:id/debug/mounts`
Diagnose volume mount issues (configured vs guest-visible mounts).

### `GET /api/v1/machines/:id/debug/network`
Diagnose networking (listening ports, interfaces, port mappings).

---

## Known Limitations

- **Volume mounts**: Files written via virtiofs may not be visible inside the
  guest (alpha bug). Workaround: write via `exec`.
- **Port mapping**: Connections refused from host side (alpha bug).
- **Container-in-machine**: `crun` storage path error for nested containers.
- **macOS UID leak**: Host UID 501 leaks into guest. Workaround: use
  `default_user` to create a non-root user.
