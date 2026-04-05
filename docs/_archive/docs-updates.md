# smolvm Gotchas & Patterns

Practical patterns and pitfalls discovered during hands-on testing of
smolvm v0.1.16. Reference this before writing any smolvm integration code.

---

## Installation

```bash
curl -fsSL https://smolmachines.com/install.sh | bash
# Installs to ~/.local/bin/smolvm
# Verify: smolvm --version → 0.1.16
```

---

## Starting the API Server

```bash
smolvm serve --listen 127.0.0.1:8080
```

- API base: `http://127.0.0.1:8080/api/v1`
- OpenAPI spec: `GET /api-docs/openapi.json`
- Swagger UI: `GET /swagger-ui/`
- No auth required (localhost only)

---

## Exec Command Format

Use `["sh", "-c", "command"]` for anything with shell syntax:

```json
// GOOD — shell syntax works
{ "command": ["sh", "-c", "echo hello && ls /tmp | wc -l"] }

// GOOD — simple command, no shell needed
{ "command": ["echo", "hello"] }

// BAD — shell syntax won't work without sh -c
{ "command": ["echo", "hello && ls"] }
```

---

## Critical Gotchas

### 1. `sh --version` Hangs on Alpine

Alpine uses busybox, which doesn't support `--version` for sh. Running
`sh --version` starts an interactive shell that hangs indefinitely.

```json
// BAD — hangs forever
{ "command": ["sh", "--version"] }

// GOOD — check if sh exists
{ "command": ["sh", "-c", "which sh && echo available"] }
```

### 2. Always Use `timeout_secs`

Exec calls without timeout can hang indefinitely if a command blocks
(interactive prompts, missing input, infinite loops).

```json
{
  "command": ["sh", "-c", "apk add git"],
  "timeout_secs": 60
}
```

### 3. Within-Machine Exec is Serial

Multiple concurrent exec calls to the same machine execute one at a time.
Three 1-second sleeps take ~3s, not ~1s.

```
// Serial (3s for 3x1s sleep)
Promise.all([
  exec("machine-1", "sleep 1"),
  exec("machine-1", "sleep 1"),
  exec("machine-1", "sleep 1"),
])

// Parallel (1s for 3x1s sleep) — use separate machinees
Promise.all([
  exec("machine-1", "sleep 1"),
  exec("machine-2", "sleep 1"),
  exec("machine-3", "sleep 1"),
])
```

### 4. Volume Mounts Don't Work (Alpha Bug)

The API accepts mount configuration and machine creation succeeds, but
files are NOT visible across the host/guest boundary.

```json
// Creates successfully but files won't be visible inside VM
{
  "name": "test",
  "resources": { "cpus": 2, "memory_mb": 1024 },
  "mounts": [{ "source": "/tmp/data", "target": "/data" }]
}
```

**Workaround — write files via exec:**
```json
{ "command": ["sh", "-c", "echo 'file contents' > /workspace/file.txt"] }
```

**Workaround — read files via exec:**
```json
{ "command": ["cat", "/workspace/file.txt"] }
```

### 5. Port Mapping Doesn't Work (Alpha Bug)

Port mapping config is accepted but connections from host are refused.

### 6. Container-in-Machine Returns 500

Image pull works, but container creation fails with crun storage path error.

### 7. Alpine Has Nothing Pre-installed

No node, python, git, curl, bash, jq. Budget ~7s for bootstrap:

```json
{
  "command": ["sh", "-c", "apk add --no-cache git curl nodejs npm bash"],
  "timeout_secs": 60
}
```

Or use a pre-built OCI image to skip bootstrap entirely.

### 8. Stop Is Slow (~2.2s)

Factor this into lifecycle calculations. Create and start are fast
(6-14ms and 258-805ms), but stop takes ~2.2s.

### 9. Advertised SDKs Don't Exist

The doc site claims `npm install smolvm` and `pip install smolvm` exist.
Both 404. The REST API via `smolvm serve` is the real programmatic
interface.

---

## Patterns

### Pattern: REST API Helper

```typescript
const API = "http://127.0.0.1:8080/api/v1";

async function apiPost(path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function exec(
  machine: string,
  command: string[],
  opts?: {
    env?: { name: string; value: string }[];
    workdir?: string;
    timeout_secs?: number;
  },
) {
  const resp = await apiPost(`/machines/${machine}/exec`, {
    command,
    ...opts,
  });
  if (!resp.ok) throw new Error(`exec failed: ${resp.status}`);
  return resp.json() as Promise<{
    exit_code: number;
    stdout: string;
    stderr: string;
  }>;
}
```

### Pattern: Full Machine Lifecycle

```typescript
// 1. Create
await apiPost("/machinees", {
  name: "my-machine",
  resources: { cpus: 2, memory_mb: 2048, network: true },
});

// 2. Start
await apiPost("/machines/my-machine/start");

// 3. Bootstrap (install tools)
await exec("my-machine", ["sh", "-c", "apk add --no-cache git nodejs npm"], {
  timeout_secs: 60,
});

// 4. Work (with env vars)
const result = await exec(
  "my-machine",
  ["sh", "-c", "cd /workspace && node agent.js"],
  {
    env: [{ name: "API_KEY", value: "sk-..." }],
    timeout_secs: 300,
  },
);

// 5. Extract results
const output = await exec("my-machine", ["cat", "/workspace/result.json"]);

// 6. Cleanup
await apiPost("/machines/my-machine/stop");
await fetch(`${API}/machines/my-machine`, { method: "DELETE" });
```

### Pattern: Fleet with Parallel Exec

```typescript
const FLEET_SIZE = 3;

// Create sequentially (fast — 6ms each)
for (let i = 0; i < FLEET_SIZE; i++) {
  await apiPost("/machinees", {
    name: `agent-${i}`,
    resources: { cpus: 2, memory_mb: 2048, network: true },
  });
}

// Start in parallel
await Promise.all(
  Array.from({ length: FLEET_SIZE }, (_, i) =>
    apiPost(`/machines/agent-${i}/start`)
  ),
);

// Exec in parallel (cross-machine = truly parallel)
const results = await Promise.all(
  Array.from({ length: FLEET_SIZE }, (_, i) =>
    exec(`agent-${i}`, ["sh", "-c", "echo working on agent " + i], {
      timeout_secs: 60,
    })
  ),
);

// Cleanup
for (let i = 0; i < FLEET_SIZE; i++) {
  await apiPost(`/machines/agent-${i}/stop`);
  await fetch(`${API}/machines/agent-${i}`, { method: "DELETE" });
}
```

### Pattern: File I/O Without Volume Mounts

Since volume mounts are buggy, use exec-based workarounds:

```typescript
// Write a file
await exec("machine", [
  "sh", "-c",
  `cat > /workspace/config.json << 'HEREDOC'
${JSON.stringify(config, null, 2)}
HEREDOC`
]);

// Read a file
const { stdout } = await exec("machine", ["cat", "/workspace/output.json"]);
const data = JSON.parse(stdout);

// List directory
const { stdout: listing } = await exec("machine", ["ls", "-la", "/workspace/"]);

// Check if file exists
const { exit_code } = await exec("machine", ["test", "-f", "/workspace/file.txt"]);
const exists = exit_code === 0;
```

### Pattern: Runtime Detection

Don't use `--version` for busybox commands. Use `which` instead:

```typescript
const runtimes = ["node", "python3", "git", "curl", "deno"];
for (const name of runtimes) {
  const { exit_code, stdout } = await exec("machine", [
    "sh", "-c",
    `which ${name} 2>/dev/null && ${name} --version 2>&1 | head -1`,
  ], { timeout_secs: 5 });
  console.log(`${name}: ${exit_code === 0 ? stdout.trim() : "not installed"}`);
}
```

---

## Performance Reference

| Operation | Time |
|-----------|------|
| Create machine (API) | 6-14ms |
| Start machine (VM boot) | 258-805ms |
| First exec after start | 12-15ms |
| Warm exec (subsequent) | 12ms |
| Total create→first exec | 281-831ms |
| CLI one-shot | ~5.5s |
| Stop machine | ~2.2s |
| Bootstrap (apk add basics) | ~7s |
| Full lifecycle (alpine) | ~10.1s |
| Full lifecycle (pre-built OCI) | ~3s |

---

## Env Var Patterns

```json
// Single env var
{
  "command": ["sh", "-c", "echo $MY_VAR"],
  "env": [{ "name": "MY_VAR", "value": "hello" }]
}

// Multiple env vars
{
  "command": ["sh", "-c", "echo $A $B $C"],
  "env": [
    { "name": "A", "value": "one" },
    { "name": "B", "value": "two" },
    { "name": "C", "value": "three" }
  ]
}

// Special characters work
{
  "env": [{ "name": "KEY", "value": "value with spaces & \"quotes\"" }]
}
```

CLI equivalent:
```bash
smolvm machine run -e MY_VAR=hello -e API_KEY=sk-... alpine:latest -- sh -c 'echo $MY_VAR'
```

---

## Three Operating Modes

| Mode | Use Case | Persistence | CLI |
|------|----------|-------------|-----|
| Machine | One-shot tasks, testing | Ephemeral (gone after stop) | `smolvm machine run` |
| MicroVM | Persistent dev environments | Survives stop/start | `smolvm microvm create/start/exec` |
| Pack | Portable distribution | Self-contained binary | `smolvm pack` |

All three are manageable via the REST API.

---

## Discoveries (2026-02-27) — MicroVM API & Coding Agents

### 10. MicroVM REST API Exists

The `/api/v1/microvms` endpoints provide full CRUD + exec for persistent
microVMs. The schema differs from machinees:

```json
// Machine create — nested resources
{ "name": "my-machine", "resources": { "cpus": 2, "memory_mb": 2048, "network": true } }

// MicroVM create — flat schema
{ "name": "my-vm", "cpus": 2, "memoryMb": 4096, "network": true, "overlay_gb": 4 }
```

Note: `memory_mb` (machine) vs `memoryMb` (microVM). The microVM API also
exposes `overlay_gb` and `storage_gb` params that machinees don't have.

### 11. `overlay_gb` Works — But Needs `resize2fs`

The `overlay_gb` parameter correctly creates a larger raw disk image. However,
the ext4 filesystem inside is always formatted at ~487MB regardless of disk
size. **The filesystem must be manually resized after boot.**

```bash
# Disk is 4GB but filesystem is 487MB
df -h /        # → overlay 487.2M
lsblk          # → vdb 4G    (disk IS 4GB!)
fdisk -l /dev/vdb  # → Disk /dev/vdb: 4 GiB

# Fix: resize the filesystem to fill the disk
apk add --no-cache e2fsprogs-extra
resize2fs /dev/vdb
df -h /        # → overlay 3.9G  ✓
```

Same applies to `/dev/vda` (storage disk, default 20GB raw, 487MB FS).

**The `overlay_gb` default is 2** (per OpenAPI spec). Even the default 2GB
disk only shows 487MB until you resize. This is likely a smolvm bug — the
formatting step should use the full disk size.

### 12. `storage_gb` Disk at `/storage`

A separate disk is mounted at `/storage` (and `/dev/vda`). Default 20GB raw.
Contains crun/OCI layer data (`configs/`, `containers/`, `layers/`, etc.)
but is writable. Can be used for large data with `resize2fs /dev/vda`.

### 13. `smolvm microvm ls` Fails When `smolvm serve` Is Running

The CLI and serve process both lock the database. Running any `smolvm microvm`
CLI command while serve is active fails with "Database already open."

**Workaround:** Use the REST API exclusively when serve is running.

### 14. Claude Code Refuses Root for `--dangerously-skip-permissions`

Claude Code's security check blocks `--dangerously-skip-permissions` when
running as root (uid 0). Since smolvm exec runs as root by default, you must
create a non-root user.

```bash
adduser -D -s /bin/sh agent
mkdir -p /home/agent/workspace /tmp/claude-1000
chown -R agent:agent /home/agent /tmp/claude-1000
```

### 15. Claude Code Needs `/tmp/claude-<uid>` Pre-Created

Claude Code's Bash tool writes temp files to `/tmp/claude-<uid>` (e.g.,
`/tmp/claude-1000` for uid 1000). If this directory doesn't exist or isn't
owned by the agent user, the Bash tool fails with `EACCES: permission denied`.

```bash
mkdir -p /tmp/claude-1000
chown agent:agent /tmp/claude-1000
```

### 16. libkrun TCP Backlog Fix for Node.js Servers

Node.js defaults to TCP listen backlog of 511. libkrun's TSI rejects this
with `EINVAL`. Any Node.js server (including Claude Code's OAuth callback)
fails without this monkey-patch:

```bash
cat > /usr/local/lib/fix-listen.js << 'EOF'
const net = require("net");
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...a) {
  if (a[0] && typeof a[0] === "object") a[0].backlog = 1;
  return origListen.apply(this, a);
};
EOF

# Apply globally via NODE_OPTIONS
export NODE_OPTIONS="--require /usr/local/lib/fix-listen.js"
```

Discovered by the smolvm-manager community project (see `docs/community/`).

### 17. Codex Requires Git Repo + Non-Interactive Subcommand

Codex CLI refuses to run outside a git repository ("Not inside a trusted
directory"). Also, `codex <prompt>` starts interactive mode which needs a
TTY. Use the `exec` subcommand for headless:

```bash
cd /home/agent/workspace && git init
codex exec "Write hello.js" --full-auto
```

### 18. Pi-Mono Needs `--ignore-scripts` on Alpine

Pi-Mono's `koffi` dependency requires `cmake`, `make`, `g++` for native
compilation. On a default 487MB overlay there isn't enough space. Using
`--ignore-scripts` skips the native build. Pi still works (v0.55.1).

```bash
npm install -g --ignore-scripts @mariozechner/pi-coding-agent
```

On a resized overlay (4GB+), full install with build tools works too:
```bash
apk add python3 make g++ cmake
npm install -g @mariozechner/pi-coding-agent
```

### 19. Shell Quoting Hell with REST API + `su`

Running agents as a non-root user via the REST API exec endpoint requires
`su - agent -c "command"` which creates nested quoting nightmares.

**Solution: Write a runner script as root, execute it as agent:**

```bash
# Write runner script (as root)
cat > /tmp/run-agent.sh << 'EOF'
#!/bin/sh
export ANTHROPIC_API_KEY=$(cat /tmp/.api-key)
export HOME=/home/agent
cd /home/agent/workspace
exec claude -p "$1" --dangerously-skip-permissions 2>&1
EOF
chmod 755 /tmp/run-agent.sh

# Write API key to file (as root, via env var)
# API call: env=[{name:"KEY", value:"sk-..."}], command: echo "$KEY" > /tmp/.api-key
chmod 644 /tmp/.api-key

# Run agent (as agent user)
su - agent -c '/tmp/run-agent.sh "Write fizzbuzz.js and run it"'
```

### 20. Gemini CLI Needs Build Tools + 4GB Overlay

Gemini CLI has native modules that require `python3 make g++`. It's also too
large for the default 487MB overlay (~400MB just for Gemini). Needs at least
4GB overlay with the `resize2fs` fix.

```bash
# After overlay resize
apk add --no-cache python3 make g++
npm install -g @google/gemini-cli
# gemini --version → 0.30.0
```

---

## Coding Agent Installation Reference

All agents verified on smolvm v0.1.16 microVMs (Alpine Linux aarch64).

| Agent | Package | Install Time | Disk | Extra Deps | Verified |
|---|---|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | 10s | ~50MB | none | YES (creates+runs code) |
| Codex | `@openai/codex` | 8s | ~23MB | git repo | YES (install only, API credits needed) |
| Pi-Mono | `@mariozechner/pi-coding-agent` | 11s | ~170MB | `--ignore-scripts` | YES (creates+runs code) |
| Gemini CLI | `@google/gemini-cli` | 13s | ~400MB | `python3 make g++`, 4GB overlay | YES (install only, API key needed) |

All four agents coexist in a single 4GB-overlay VM (1.5GB used, 39%).

### Headless Flags

| Agent | Non-Interactive | Auto-Approve | Resume |
|---|---|---|---|
| Claude Code | `-p "prompt"` | `--dangerously-skip-permissions` | `--resume` |
| Codex | `exec "prompt"` | `--full-auto` | `resume --last` |
| Pi-Mono | `-p "prompt"` | (not needed) | `-c` (continue) |
| Gemini CLI | `-i "prompt"` | `--yolo` | `--resume` |

---

## MicroVM API Reference (Discovered)

### Endpoints

```
POST   /api/v1/microvms                    Create
GET    /api/v1/microvms                    List
GET    /api/v1/microvms/{name}             Get
DELETE /api/v1/microvms/{name}             Delete
POST   /api/v1/microvms/{name}/start       Start
POST   /api/v1/microvms/{name}/stop        Stop
POST   /api/v1/microvms/{name}/exec        Execute command
```

### Create Schema

```json
{
  "name": "my-vm",           // required, unique
  "cpus": 2,                 // default: 1
  "memoryMb": 4096,          // default: 256
  "network": true,           // default: false
  "overlay_gb": 4,           // default: 2 (but FS is 487MB — needs resize2fs!)
  "storage_gb": 20,          // default: 20
  "mounts": [],              // host mounts (buggy)
  "ports": []                // port mappings (buggy)
}
```

### Exec Schema

```json
{
  "command": ["sh", "-c", "echo hello"],
  "env": [{"name": "KEY", "value": "val"}],
  "timeout_secs": 60
}
// Returns: { "exit_code": 0, "stdout": "hello\n", "stderr": "" }
```

### Key Differences from Machine API

| | Machine | MicroVM |
|---|---|---|
| Endpoint | `/api/v1/machines` | `/api/v1/microvms` |
| Memory param | `resources.memory_mb` | `memoryMb` |
| CPU param | `resources.cpus` | `cpus` |
| Network param | `resources.network` | `network` |
| Overlay size | No param | `overlay_gb` |
| Storage size | No param | `storage_gb` |
| Persistence | Ephemeral | Survives stop/start |
| ID field | `name` | `name` |
