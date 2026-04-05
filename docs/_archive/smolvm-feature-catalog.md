# smolvm Feature Catalog — Post-Evaluation (v0.1.16)

## Executive Summary

smolvm is a local micro-VM tool: sub-300ms boot, OCI image compatibility,
true VM isolation, Apache-2.0 licensed, single binary. It has a **full REST
API** via `smolvm serve` (localhost:8080) that supports machine, microVM,
and container management — this is undocumented on the website and the
advertised npm/pip SDKs don't exist (404).

For coding agent workloads, the REST API makes orchestration viable today.
The main gaps are checkpoint/restore, volume mount bugs, and documentation.

---

## 1. Feature Inventory (Verified by Testing)

| Feature | Status | Verified | Details |
|---------|--------|----------|---------|
| Machine mode (ephemeral) | Yes | Yes | Full CRUD via REST API + CLI |
| MicroVM mode (persistent) | Yes | Yes | Full CRUD + exec via REST API |
| Pack mode (portable) | Yes | No | Single-file or dual-file executables |
| OCI image support | Yes | Yes | alpine, node:22-alpine, python:3.13-alpine tested |
| REST API (`smolvm serve`) | Yes | Yes | Full HTTP API on localhost:8080 |
| OpenAPI 3.1 spec | Yes | Yes | `/api-docs/openapi.json` |
| Swagger UI | Yes | Yes | `/swagger-ui/` |
| Network (TCP/UDP) | Yes | Yes | Outbound HTTPS + DNS confirmed |
| Env var passthrough (CLI) | Yes | Yes | `-e KEY=VALUE` works |
| Env var passthrough (API) | Yes | Yes | `env: [{name, value}]` in exec |
| Volume mounts (CLI) | Yes | Buggy | Create+start succeed, files not visible |
| Volume mounts (API) | Yes | Buggy | Same — alpha bug |
| Port mapping | Yes | Buggy | Creates but connection refused |
| CPU allocation | Yes | Yes | `resources.cpus` in API |
| Memory allocation | Yes | Yes | `resources.memory_mb` in API |
| Smolfile (TOML config) | Yes | No | Declarative VM config |
| Container-in-machine | Yes | Buggy | Image pull works, container create 500s |
| SSE log streaming | Yes | No | `/machines/{id}/logs` endpoint |
| macOS Apple Silicon | Yes | Yes | Tested on M-series |
| Linux support | Planned | No | "coming soon" per docs |
| Programmatic SDK (npm) | No | Confirmed 404 | Site claims it exists |
| Programmatic SDK (pip) | No | Confirmed 404 | Site claims it exists |
| Checkpoint/restore | No | — | Not available |
| File copy in/out | No | — | Must use volume mounts or exec |
| Egress filtering | No | — | `--net` is all-or-nothing |
| Resource monitoring | No | — | No stats endpoint |

---

## 2. REST API Reference (Discovered via Testing)

The REST API is the **real programmatic interface**. The website claims
TypeScript (`npm install smolvm`) and Python (`pip install smolvm`) SDKs
exist, but both 404 on their respective registries.

### Base URL

```
http://127.0.0.1:8080/api/v1
```

Start the server:

```bash
smolvm serve --listen 127.0.0.1:8080
```

### Endpoints (Verified)

#### Health

```
GET /health → { status: "ok", version: "0.1.16" }
```

#### Machinees

```
POST   /api/v1/machines                     — Create machine
GET    /api/v1/machines                     — List machinees
GET    /api/v1/machines/{name}              — Get machine info
POST   /api/v1/machines/{name}/start        — Start machine
POST   /api/v1/machines/{name}/stop         — Stop machine
DELETE /api/v1/machines/{name}              — Delete machine
POST   /api/v1/machines/{name}/exec         — Execute command
GET    /api/v1/machines/{name}/logs         — Stream logs (SSE)
POST   /api/v1/machines/{name}/run          — Run in OCI image overlay
```

#### MicroVMs

```
POST   /api/v1/microvms                      — Create microVM
GET    /api/v1/microvms                      — List microVMs
GET    /api/v1/microvms/{name}               — Get microVM info
POST   /api/v1/microvms/{name}/start         — Start microVM
POST   /api/v1/microvms/{name}/stop          — Stop microVM
DELETE /api/v1/microvms/{name}               — Delete microVM
POST   /api/v1/microvms/{name}/exec          — Execute command
```

#### Images

```
POST   /api/v1/machines/{name}/images/pull  — Pull OCI image
GET    /api/v1/machines/{name}/images       — List images
DELETE /api/v1/machines/{name}/images/{id}  — Delete image
```

#### Containers (in machine)

```
POST   /api/v1/machines/{name}/containers           — Create container
GET    /api/v1/machines/{name}/containers           — List containers
GET    /api/v1/machines/{name}/containers/{id}      — Get container
POST   /api/v1/machines/{name}/containers/{id}/start — Start container
POST   /api/v1/machines/{name}/containers/{id}/stop  — Stop container
DELETE /api/v1/machines/{name}/containers/{id}      — Delete container
POST   /api/v1/machines/{name}/containers/{id}/exec  — Exec in container
```

### Request/Response Types

#### CreateMachineRequest

```json
{
  "name": "my-machine",
  "resources": {
    "cpus": 2,
    "memory_mb": 1024,
    "network": true,
    "storage_gb": 20,
    "overlay_gb": 2
  },
  "mounts": [
    { "source": "/host/path", "target": "/guest/path", "readonly": false }
  ],
  "ports": [
    { "host": 8080, "guest": 80, "protocol": "tcp" }
  ]
}
```

#### ExecRequest

```json
{
  "command": ["sh", "-c", "echo hello"],
  "env": [
    { "name": "MY_VAR", "value": "my-value" }
  ],
  "workdir": "/tmp",
  "timeout_secs": 30
}
```

#### ExecResponse

```json
{
  "exit_code": 0,
  "stdout": "hello\n",
  "stderr": ""
}
```

---

## 3. Performance Benchmarks (Measured)

### Boot Timing

| Metric | Time |
|--------|------|
| Create machine (API) | 6-14ms |
| Start machine (VM boot) | 258-805ms |
| First exec after start | 12-15ms |
| Warm exec (subsequent) | 12ms |
| Total create→first exec | 281-831ms |
| CLI one-shot (`machine run`) | ~5.5s |
| Stop machine | ~2.2s |

### Agent Lifecycle

| Phase | Time | What |
|-------|------|------|
| CREATE | 0.8s | POST /machinees + start |
| BOOTSTRAP | 7.0s | apk add git curl nodejs npm |
| WORK | 0.07s | sed + node test |
| EXTRACT | 0.04s | git diff + cat |
| DESTROY | 2.2s | stop + delete |
| **TOTAL** | **10.1s** | |

With a pre-built OCI image (no bootstrap): ~3s total.

### Fleet Performance

| Metric | Result |
|--------|--------|
| Sequential create | 6ms/machine |
| Parallel start (3) | 245ms total (82ms/machine) |
| Cross-machine parallel exec | 1011ms for 3x1s sleep (truly parallel) |
| Within-machine exec | Serial (3043ms for 3x1s sleep) |
| State isolation | Confirmed |

---

## 4. Known Bugs (Alpha)

### Volume Mounts Not Working

REST API accepts mount config and machine create+start succeed (HTTP 200),
but files written on host aren't visible inside the VM and vice versa.
Likely a virtiofs mount point issue.

### Port Mapping Not Working

Port mapping config accepted, machine starts, but connecting from host to
the mapped port returns "Connection refused". Either httpd isn't available
in the Alpine image or port forwarding is incomplete.

### Container-in-Machine 500 Error

`POST /machines/{name}/containers` returns 500:
```
container created but failed to start: crun start failed (exit 1):
error opening file `/storage/containers/crun/.../status`: No such file or directory
```

### Exec Serialization

Multiple concurrent exec calls to the same machine execute serially, not
in parallel. Cross-machine parallelism works fine.

### `sh --version` Hangs on Busybox

Alpine uses busybox's sh, which doesn't support `--version`. Running
`sh --version` starts an interactive shell that hangs indefinitely. Use
`which sh && echo 'available'` instead. Always add `timeout_secs` to exec
calls as a safety net.

---

## 5. What's Still Missing for Agent Workloads

### CRITICAL: Checkpoint/Restore

No way to snapshot VM state and rollback. Agents need this for risky
operations (e.g., checkpoint before each iteration, restore on test failure).

**Comparison:** Fly Sprites has checkpoint/restore (~400ms create, ~14s
restore). Deno has volume snapshots (~13s).

### IMPORTANT: File Copy In/Out

No `cp` command or API endpoint. Must use volume mounts (which are currently
buggy) or `exec cat` workarounds.

**Comparison:** Fly Sprites has full filesystem REST API (read/write/list).
Cloudflare SDK has readFile/writeFile.

### IMPORTANT: Documentation

The doc site (smolmachines.com) has significant issues:
- Claims TypeScript and Python SDKs exist — both 404
- API documentation pages are empty shells
- The REST API (best feature) is completely undocumented on the site
- OpenAPI spec exists but isn't linked from docs

### NICE-TO-HAVE: Egress Filtering

`--net` is all-or-nothing. No domain-based allowlists.

### NICE-TO-HAVE: Resource Monitoring

No `stats` endpoint or command for CPU/memory/disk usage.

---

## 6. Corrected Comparison Matrix

| Capability | smolvm (actual) | Fly Sprites | Deno Machine | Cloudflare |
|------------|----------------|-------------|--------------|------------|
| Boot time | **~300ms** | ~500ms | ~1-2s | ~30s cold |
| Isolation | VM (libkrun) | VM (Firecracker) | VM | Container |
| Programmatic API | **REST API** | REST + SDK | SDK (JSR) | SDK (npm) |
| Env vars | **Real per-exec** | Real per-exec | Proxy placeholders | Proxy-level |
| File I/O | exec cat/volume | REST API | SDK | SDK |
| Persistence | stop/start | Checkpoints | Snapshots | None |
| Networking | TCP/UDP | TCP/UDP + L3 egress | HTTPS proxy | Full + preview |
| Multi-machine | REST API | REST API | SDK | max_instances |
| Cost | **Free (local)** | ~$0.44/4hr | Per-usage | $5/mo + usage |
| Location | **Local** | Cloud | Cloud | Cloud |
| Pre-installed tools | Nothing | Everything | Deno+Node+Python | Docker image |
| Checkpoint/restore | No | Yes (~400ms) | Yes (~13s) | No |
| Documentation | Poor | Good | Good | Good |
| Status | Alpha | GA | Pre-release | Public beta |

---

## 7. Recommendations for smolvm Team

Updated priority list based on actual testing:

| Priority | Feature | Notes |
|----------|---------|-------|
| 1 | **Fix volume mounts** | Currently broken — blocks file I/O |
| 2 | **Document the REST API** | Best feature, completely hidden |
| 3 | **Fix port mapping** | Creates but doesn't work |
| 4 | **Add checkpoint/restore** | Key differentiator for agent workloads |
| 5 | **Add file copy API endpoint** | `POST /machines/{id}/files` |
| 6 | **Fix container-in-machine** | crun storage path error |
| 7 | **Remove fake SDK references from docs** | npm/pip both 404 |
| 8 | **Add resource monitoring endpoint** | `GET /machines/{id}/stats` |
| 9 | **Add egress filtering** | Domain-based allowlists |
| 10 | **Linux support** | Already planned |

Items 1-3 are documentation/bug fixes that would dramatically improve the
developer experience. Items 4-5 would make smolvm competitive with cloud
machinees for agent workloads.

---

## 8. The Pitch (Updated)

smolvm already has the fastest boot of any machine tested (~300ms) and a
functional REST API for programmatic orchestration. It's the only free,
local-first, open-source option with true VM isolation.

The main blockers are fixable: volume mounts need debugging, the REST API
needs documentation, and the fake SDK references need removing. With those
fixes plus checkpoint/restore, smolvm becomes the obvious choice for local
agent development before deploying to cloud machinees for production.

**Today's workflow (works):**

```typescript
// Create machine via REST API
await fetch("http://localhost:8080/api/v1/machines", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "agent-001",
    resources: { cpus: 2, memory_mb: 2048, network: true },
  }),
});

// Start + exec
await fetch("http://localhost:8080/api/v1/machines/agent-001/start", { method: "POST" });
const result = await fetch("http://localhost:8080/api/v1/machines/agent-001/exec", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    command: ["sh", "-c", "echo hello world"],
    env: [{ name: "API_KEY", value: "sk-..." }],
    timeout_secs: 30,
  }),
});
```

This is ~50 lines of TypeScript with no SDK needed — just `fetch()`.
