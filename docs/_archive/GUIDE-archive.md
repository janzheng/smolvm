# smolvm Usage Guide

Orchestrate isolated micro-VMs as self-served "computers" for agents, dev tools, and batch workloads. Each VM boots in ~300ms, runs Linux, and is fully controllable via REST API or SDK.

## Install

```bash
curl -sSL https://smolmachines.com/install.sh | bash
```

Installs the `smolvm` binary to `~/.local/bin/smolvm`. No Rust toolchain needed.

**Requirements:**
- macOS 11+ with Apple Silicon (uses Hypervisor.framework) or Linux with KVM
- SSH key pair (`~/.ssh/id_ed25519` or `~/.ssh/id_rsa`)
- For TypeScript SDK: Deno
- For Python SDK: Python 3.10+ with `httpx` (`pip install httpx`)

## Quick Start

### 1. Start the Server

```bash
smolvm serve --listen 127.0.0.1:8080
```

Options:
- `--cors-origin <origin>` — allow CORS from specific origins
- `--json-logs` — structured JSON log output (production)
- `-v` — verbose/debug logging
- `RUST_LOG=smolvm=debug` — fine-grained log level control

The server exposes a REST API at `http://127.0.0.1:8080/api/v1` and interactive docs at `http://127.0.0.1:8080/swagger-ui`.

### 2. Create and Use a Sandbox

**cURL:**

```bash
# Create a sandbox with networking
curl -X POST http://localhost:8080/api/v1/sandboxes \
  -H 'Content-Type: application/json' \
  -d '{"name": "dev-01", "resources": {"cpus": 2, "memory_mb": 2048, "network": true}}'

# Start it
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/start

# Run a command
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/exec \
  -H 'Content-Type: application/json' \
  -d '{"command": ["echo", "hello from the sandbox"], "timeout_secs": 30}'

# Run a shell command (pipes, redirects, etc.)
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/exec \
  -H 'Content-Type: application/json' \
  -d '{"command": ["sh", "-c", "uname -a && cat /etc/os-release | grep PRETTY"]}'

# Stop and delete
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/stop
curl -X DELETE http://localhost:8080/api/v1/sandboxes/dev-01
```

**TypeScript SDK:**

```typescript
import { SmolvmClient } from "./sdk-ts/mod.ts";

const client = new SmolvmClient(); // defaults to http://127.0.0.1:8080
const sandbox = await client.createAndStart("dev-01", {
  cpus: 2,
  memoryMb: 2048,
  network: true,
});

const result = await sandbox.sh("echo hello && uname -a");
console.log(result.stdout);

await sandbox.cleanup(); // stop + delete
```

**Python SDK:**

```python
from smolvm import SmolvmClient

client = SmolvmClient()  # defaults to http://127.0.0.1:8080
sandbox = await client.create_and_start("dev-01", cpus=2, memory_mb=2048, network=True)

result = await sandbox.sh("echo hello && uname -a")
print(result.stdout)

await sandbox.cleanup()  # stop + delete
```

---

## Starter Images

Pre-configured environments with common tools pre-installed. Skip bootstrap entirely.

| Starter | What's Included | Size |
|---------|----------------|------|
| `claude-code` | Node 20 + Python 3 + Deno + Claude Code CLI + git | ~500MB |
| `node-deno` | Node 20 + npm + Deno + git | ~300MB |
| `python-ml` | Python 3 + numpy + pandas + scipy + Node + Deno | ~400MB |
| `universal` | Node + Python + Deno + Rust + Go | ~800MB |

```bash
# Create from a starter
curl -X POST http://localhost:8080/api/v1/sandboxes \
  -d '{"name": "agent-01", "from_starter": "claude-code", "resources": {"network": true}}'
```

```typescript
const sandbox = await client.createAndStart("agent-01", { fromStarter: "claude-code", network: true });
```

---

## Execution

### Basic Exec

Execute a command array directly (no shell processing):

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/exec \
  -d '{"command": ["node", "--version"]}'
```

### Shell Commands

For pipes, redirects, variable expansion — wrap in `sh -c`:

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/exec \
  -d '{"command": ["sh", "-c", "ls -la /app && echo done"]}'
```

SDK shortcut: `sandbox.sh("ls -la /app && echo done")`

### Environment Variables

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/exec \
  -d '{"command": ["sh", "-c", "echo $MY_KEY"], "env": [{"name": "MY_KEY", "value": "secret123"}]}'
```

### Non-Root Execution

Run as a specific user:

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/exec \
  -d '{"command": ["whoami"], "user": "agent"}'
```

### Init Commands

Run setup commands automatically when the sandbox is created:

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes \
  -d '{
    "name": "dev-02",
    "resources": {"network": true},
    "init_commands": ["apk add nodejs npm git", "npm install -g typescript"]
  }'
```

### Timeouts

Default timeout is 30 seconds. Override per-command:

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/exec \
  -d '{"command": ["sh", "-c", "sleep 120 && echo done"], "timeout_secs": 180}'
```

---

## File Operations

### Write a File

Content is base64-encoded for transport:

```bash
curl -X PUT http://localhost:8080/api/v1/sandboxes/dev-01/files/app%2Fmain.ts \
  -d '{"content": "Y29uc29sZS5sb2coImhlbGxvIik=", "permissions": "0644"}'
```

SDK handles encoding automatically:

```typescript
await sandbox.writeFile("/app/main.ts", 'console.log("hello")');
await sandbox.writeFiles({
  "/app/main.ts": 'console.log("hello");',
  "/app/package.json": '{"name": "test"}',
});
```

### Read a File

```bash
curl http://localhost:8080/api/v1/sandboxes/dev-01/files/app%2Fmain.ts
# Returns: {"content": "<base64>", "path": "/app/main.ts", "size": 22}
```

```typescript
const content = await sandbox.readFile("/app/main.ts");
```

### List Files

```bash
curl http://localhost:8080/api/v1/sandboxes/dev-01/files?dir=/app
```

### Delete a File

```bash
curl -X DELETE http://localhost:8080/api/v1/sandboxes/dev-01/files/app%2Fmain.ts
```

### Upload Binary Files (Multipart)

For large or binary files — no base64 overhead:

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/upload/app%2Fdata.bin \
  -F "file=@./local-file.bin" \
  -F "permissions=0755"
```

```typescript
const data = await Deno.readFile("./local-file.bin");
await sandbox.uploadFile("/app/data.bin", data, "0755");
```

### Upload/Download Directory Archives

Transfer entire directory trees as tar.gz:

```bash
# Upload a tar.gz and extract into /app
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/archive/upload?dir=/app \
  -H 'Content-Type: application/gzip' \
  --data-binary @./project.tar.gz

# Download /app as tar.gz
curl http://localhost:8080/api/v1/sandboxes/dev-01/archive?dir=/app -o backup.tar.gz
```

```typescript
const archive = await Deno.readFile("./project.tar.gz");
await sandbox.uploadArchive(archive, "/app");

const backup = await sandbox.downloadArchive("/app");
await Deno.writeFile("backup.tar.gz", backup);
```

---

## Git-Like Workflows

### Clone (Fork) a Sandbox

Create an independent copy. Instant on macOS APFS (copy-on-write):

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/clone \
  -d '{"name": "dev-01-fork"}'
```

```typescript
const fork = await sandbox.clone("dev-01-fork");
// Both dev-01 and dev-01-fork are now independent
```

### Diff Two Sandboxes

See what files changed between two sandboxes:

```bash
curl http://localhost:8080/api/v1/sandboxes/dev-01/diff/dev-01-fork
```

```typescript
const diff = await sandbox.diff("dev-01-fork");
// diff.files: [{path: "/app/main.ts", status: "modified"}, ...]
```

### Merge Sandboxes

Apply changes from one sandbox to another:

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01-fork/merge/dev-01 \
  -d '{"strategy": "theirs"}'
```

Strategies:
- `theirs` — source wins on conflicts (default)
- `ours` — target wins on conflicts

```typescript
await fork.merge("dev-01", { strategy: "theirs" });
```

---

## Snapshots (Export/Import)

### Push (Export) a Snapshot

Save a sandbox's full state for later:

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/push
```

### List Snapshots

```bash
curl http://localhost:8080/api/v1/snapshots
```

### Pull (Import) a Snapshot

Restore a snapshot into a new sandbox:

```bash
curl -X POST http://localhost:8080/api/v1/snapshots/dev-01/pull \
  -d '{"name": "dev-01-restored"}'
```

### Delete a Snapshot

```bash
curl -X DELETE http://localhost:8080/api/v1/snapshots/dev-01
```

---

## Fleet Operations

Spin up and manage multiple sandboxes in parallel.

**TypeScript:**

```typescript
// Create 5 sandboxes named worker-0 through worker-4
const fleet = await client.createFleet("worker", 5, { network: true });

// Run a command on all of them
const results = await fleet.execAll("echo hello from $(hostname)");
results.forEach((r, i) => console.log(`worker-${i}: ${r.stdout}`));

// Run different commands on each
await fleet.execEach((sandbox, i) =>
  sandbox.sh(`echo "I am worker ${i}"`)
);

// Access individual sandboxes
const worker2 = fleet.at(2);
await worker2.sh("npm install");

// Clean up all
await fleet.cleanup();
```

**Python:**

```python
fleet = await client.create_fleet("worker", 5, network=True)
results = await fleet.exec_all("echo hello")
await fleet.cleanup()
```

---

## Egress Filtering

Restrict which domains a sandbox can access:

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes \
  -d '{
    "name": "restricted",
    "resources": {"network": true},
    "allowed_domains": ["api.anthropic.com", "registry.npmjs.org", "github.com"]
  }'
```

> Note: VMM-level enforcement is pending upstream support. Currently, domain rules are logged and configurable but not strictly enforced at the network layer.

---

## OCI Images & Containers

### Pull an Image

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/images/pull \
  -d '{"image": "docker.io/library/alpine:latest"}'
```

### Run a Command in an Image

Ephemeral overlay — sandbox filesystem is untouched:

```bash
curl -X POST http://localhost:8080/api/v1/sandboxes/dev-01/run \
  -d '{"image": "alpine:latest", "command": ["echo", "hello from alpine"]}'
```

---

## Remote Access via Tunnel

The smolvm API is designed to be tunneled. One tunnel on the host = remote access to all sandboxes.

### Setup (Cloudflare Tunnel)

```bash
# On the host machine running smolvm serve
cloudflared tunnel --url http://localhost:8080
```

This gives you a public URL like `https://xyz.trycloudflare.com`. All API operations work through the tunnel — exec, file I/O, streaming, snapshots.

### Setup (ngrok)

```bash
ngrok http 8080
```

### Using the Remote URL

Point the SDK at the tunnel URL:

```typescript
const client = new SmolvmClient("https://xyz.trycloudflare.com");
```

```python
client = SmolvmClient("https://xyz.trycloudflare.com")
```

Or set the environment variable:

```bash
export SMOLVM_URL=https://xyz.trycloudflare.com
```

### In-VM Tunnels (Web Preview)

If a sandbox runs a web server you want publicly accessible, install cloudflared inside the VM:

```typescript
await sandbox.sh("curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared");
await sandbox.sh("cloudflared tunnel --url http://localhost:3000 &");
```

This is only needed for web app preview — NOT for the core API access.

---

## Monitoring & Diagnostics

### Health Check

```bash
curl http://localhost:8080/health
```

### Prometheus Metrics

```bash
curl http://localhost:8080/metrics
```

Metrics include: `smolvm_sandboxes_created_total`, `smolvm_exec_duration_seconds`, active sandbox counts, and more.

### Resource Stats

```bash
curl http://localhost:8080/api/v1/sandboxes/dev-01/stats
# Returns: cpus, memory_mb, state, disk sizes
```

### Debug Diagnostics

```bash
# Check mount status
curl http://localhost:8080/api/v1/sandboxes/dev-01/debug/mounts

# Check network config
curl http://localhost:8080/api/v1/sandboxes/dev-01/debug/network
```

### Structured Logging

```bash
smolvm serve --listen 127.0.0.1:8080 --json-logs
```

---

## API Reference

Full OpenAPI 3.1 spec available at:
- **Swagger UI:** `http://localhost:8080/swagger-ui`
- **JSON spec:** `http://localhost:8080/api-docs/openapi.json`

### Endpoint Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/metrics` | Prometheus metrics |
| **Sandboxes** | | |
| `POST` | `/api/v1/sandboxes` | Create sandbox |
| `GET` | `/api/v1/sandboxes` | List all sandboxes |
| `GET` | `/api/v1/sandboxes/{id}` | Get sandbox info |
| `POST` | `/api/v1/sandboxes/{id}/start` | Start sandbox |
| `POST` | `/api/v1/sandboxes/{id}/stop` | Stop sandbox |
| `DELETE` | `/api/v1/sandboxes/{id}` | Delete sandbox |
| `GET` | `/api/v1/sandboxes/{id}/stats` | Resource statistics |
| **Execution** | | |
| `POST` | `/api/v1/sandboxes/{id}/exec` | Execute command |
| `GET` | `/api/v1/sandboxes/{id}/exec/stream` | WebSocket streaming exec |
| `POST` | `/api/v1/sandboxes/{id}/run` | Run in OCI image |
| **Files** | | |
| `GET` | `/api/v1/sandboxes/{id}/files` | List files |
| `GET` | `/api/v1/sandboxes/{id}/files/{path}` | Read file |
| `PUT` | `/api/v1/sandboxes/{id}/files/{path}` | Write file |
| `DELETE` | `/api/v1/sandboxes/{id}/files/{path}` | Delete file |
| `POST` | `/api/v1/sandboxes/{id}/upload/{path}` | Multipart upload |
| `POST` | `/api/v1/sandboxes/{id}/archive/upload` | Upload tar.gz |
| `GET` | `/api/v1/sandboxes/{id}/archive` | Download tar.gz |
| **Orchestration** | | |
| `POST` | `/api/v1/sandboxes/{id}/clone` | Clone sandbox |
| `GET` | `/api/v1/sandboxes/{id}/diff/{other}` | Diff two sandboxes |
| `POST` | `/api/v1/sandboxes/{id}/merge/{target}` | Merge sandboxes |
| **Snapshots** | | |
| `POST` | `/api/v1/sandboxes/{id}/push` | Export snapshot |
| `GET` | `/api/v1/snapshots` | List snapshots |
| `POST` | `/api/v1/snapshots/{name}/pull` | Import snapshot |
| `DELETE` | `/api/v1/snapshots/{name}` | Delete snapshot |
| **Starters** | | |
| `GET` | `/api/v1/starters` | List starter images |
| **Images** | | |
| `GET` | `/api/v1/sandboxes/{id}/images` | List pulled images |
| `POST` | `/api/v1/sandboxes/{id}/images/pull` | Pull OCI image |
| **Containers** | | |
| `POST` | `/api/v1/sandboxes/{id}/containers` | Create container |
| `POST` | `/api/v1/sandboxes/{id}/containers/{cid}/start` | Start container |
| `POST` | `/api/v1/sandboxes/{id}/containers/{cid}/exec` | Exec in container |
| `POST` | `/api/v1/sandboxes/{id}/containers/{cid}/stop` | Stop container |
| `DELETE` | `/api/v1/sandboxes/{id}/containers/{cid}` | Delete container |
| **MicroVMs** | | |
| `POST` | `/api/v1/microvms` | Create MicroVM |
| `GET` | `/api/v1/microvms` | List MicroVMs |
| `GET` | `/api/v1/microvms/{name}` | Get MicroVM info |
| `POST` | `/api/v1/microvms/{name}/start` | Start MicroVM |
| `POST` | `/api/v1/microvms/{name}/stop` | Stop MicroVM |
| `DELETE` | `/api/v1/microvms/{name}` | Delete MicroVM |
| `POST` | `/api/v1/microvms/{name}/exec` | Exec in MicroVM |
| **Debug** | | |
| `GET` | `/api/v1/sandboxes/{id}/debug/mounts` | Mount diagnostics |
| `GET` | `/api/v1/sandboxes/{id}/debug/network` | Network diagnostics |

---

## Known Limitations

| Issue | Impact | Workaround |
|-------|--------|------------|
| Volume mounts (T01) | Files via virtiofs not visible in guest | Use file API + multipart upload + tar archives |
| Port mapping (T02) | Can't access VM ports from host | Use cloudflare/ngrok tunnels (egress works) |
| Container-in-sandbox (T04) | Persistent containers fail (500 error) | Use `run` endpoint for ephemeral containers |
| macOS UID leak (T06) | Host UID 501 leaks into guest | Init commands: `chown root:root /var/empty` |
| Egress filtering | Domain rules not enforced at network layer | Use proxy-based filtering inside VM |
| Serial exec | One exec at a time per sandbox | Use fleet for parallelism across sandboxes |

---

## Architecture

```
[You / Agent / Phone / Browser]
        │
        ▼
  cloudflare tunnel (optional)
        │
        ▼
  ┌─────────────────────┐
  │  smolvm serve :8080 │  ← REST API + OpenAPI
  │  (host machine)     │
  └─────┬───────────────┘
        │
   ┌────┼────┬────┬────┐
   ▼    ▼    ▼    ▼    ▼
  VM1  VM2  VM3  VM4  VM5   ← libkrun micro-VMs (~300ms boot)
  Each: isolated Linux, own filesystem, own network
```

Core tenet: **separate interaction from execution.** The agent's computer (memory, files, tools, state) lives inside a smolvm sandbox. You just connect to it from wherever.
