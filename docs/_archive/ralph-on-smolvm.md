# Running Coding Agents on smolvm

Integration guide for running coding agents (ralph, Claude Code, etc.)
inside smolvm micro VMs, with control plane design for N parallel instances.

**Updated post-evaluation:** smolvm has a REST API via `smolvm serve` that
makes programmatic orchestration straightforward. Env vars work. Volume
mounts are buggy but exec-based file I/O works.

---

## 1. What an Agent Needs

| Dependency | Purpose | Install method |
|-----------|---------|---------------|
| `git` | Workspace init, diff capture | `apk add git` |
| `node` + `npm` | Agent CLI, runtime | `apk add nodejs npm` or OCI image |
| `deno` | Alt runtime, test execution | `apk add --no-cache curl && curl -fsSL https://deno.land/install.sh \| sh` |
| `claude` CLI | Coding agent | `npm install -g @anthropic-ai/claude-code` |
| `curl` | Downloading tools | `apk add curl` |
| `bash` | Harness scripts | `apk add bash` (Alpine default is busybox sh) |
| `ANTHROPIC_API_KEY` | Claude auth | Env var via REST API or CLI `-e` |
| Network access | npm, Anthropic API, GitHub | `network: true` in machine config |

**Total bootstrap time:** ~7s via `apk add` on Alpine base.

---

## 2. Three Ways to Run

### Option A: REST API (Recommended)

Best for programmatic orchestration. Start `smolvm serve` once, manage
everything via HTTP.

```typescript
const API = "http://127.0.0.1:8080/api/v1";

// Create + start machine
await fetch(`${API}/machinees`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "agent-001",
    resources: { cpus: 2, memory_mb: 2048, network: true },
  }),
});
await fetch(`${API}/machines/agent-001/start`, { method: "POST" });

// Bootstrap (install tools)
await fetch(`${API}/machines/agent-001/exec`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    command: ["sh", "-c", "apk add --no-cache git curl nodejs npm"],
    timeout_secs: 60,
  }),
});

// Run agent with env vars
const result = await fetch(`${API}/machines/agent-001/exec`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    command: ["sh", "-c", "cd /workspace && node agent.js"],
    env: [
      { name: "ANTHROPIC_API_KEY", value: "test-ant-..." },
      { name: "TASK", value: "Fix the auth bug" },
    ],
    timeout_secs: 300,
  }),
});

const { exit_code, stdout, stderr } = await result.json();
```

### Option B: CLI (Quick one-off)

Good for manual testing. Slower (~5.5s per invocation).

```bash
smolvm machine run \
  --net \
  --cpus 2 \
  --mem 2048 \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  alpine:latest \
  -- sh -c 'apk add git nodejs npm && node --version'
```

### Option C: Custom OCI Image (Fastest repeated use)

Build a Docker image with everything pre-installed:

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache git curl bash jq
RUN npm install -g @anthropic-ai/claude-code
ENV PATH="/root/.deno/bin:$PATH"
```

Then use it via REST API or CLI — bootstrap phase drops to ~0s, total
lifecycle drops from 10.1s to ~3s.

---

## 3. What Works Today (Verified)

| Feature | Status | Notes |
|---------|--------|-------|
| REST API orchestration | Works | Full CRUD + exec via HTTP |
| Env var passthrough (API) | Works | `env: [{name, value}]` in exec requests |
| Env var passthrough (CLI) | Works | `-e KEY=VALUE` flag |
| Multiple env vars | Works | Array of {name, value} pairs |
| Special chars in env vals | Works | Quotes, spaces, equals signs |
| Shell command execution | Works | `["sh", "-c", "complex command"]` |
| Outbound HTTPS | Works | `network: true` in config |
| DNS resolution | Works | Resolves hostnames correctly |
| File persistence across exec | Works | Files written in one exec visible in next |
| File persistence across stop/start | Works | Packages and files survive reboot |
| OCI image pull + run | Works | `node:22-alpine`, `python:3.13-alpine` tested |
| Multiple machinees | Works | REST API manages them independently |
| Cross-machine parallelism | Works | Truly parallel exec across machinees |
| OpenAPI spec | Works | `/api-docs/openapi.json` |
| Swagger UI | Works | `/swagger-ui/` |

---

## 4. What Doesn't Work (Yet)

| Feature | Issue | Workaround |
|---------|-------|-----------|
| Volume mounts | Files not visible inside VM | Use `exec cat` or `exec sh -c 'echo data > file'` |
| Port mapping | Connection refused | Run server inside VM, curl via exec |
| Container-in-machine | 500 error from crun | Use machine exec directly |
| Within-machine parallelism | Exec is serial per machine | Use multiple machinees for parallelism |
| Checkpoint/restore | Not implemented | Stop/start preserves state but can't snapshot |
| File copy API | No endpoint | Pipe via exec: `exec sh -c 'cat /path/to/file'` |

---

## 5. Control Plane Design

### Architecture

```
┌────────────────────────────────────────────────────────┐
│          Control Plane (Deno/TypeScript)                │
│                                                        │
│  ┌───────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ Task       │  │ Machine    │  │ Results           │  │
│  │ Queue      │  │ Pool       │  │ Collector         │  │
│  │            │  │            │  │                    │  │
│  │ task-0.md  │  │ max: 8     │  │ /results/          │  │
│  │ task-1.md  │  │ active: 5  │  │   agent-001.json   │  │
│  │ task-2.md  │  │ idle: 3    │  │   agent-002.json   │  │
│  └───────────┘  └───────────┘  └──────────────────┘  │
│        │              │                │               │
│        ▼              ▼                ▼               │
│  ┌─────────────────────────────────────────────────┐  │
│  │        REST API Client (fetch-based)             │  │
│  │  POST /machinees → create/start/exec/stop/delete │  │
│  └─────────────────────────────────────────────────┘  │
│       │         │         │         │                  │
│       ▼         ▼         ▼         ▼                  │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐        │
│  │Machine │ │Machine │ │Machine │ │Machine │        │
│  │  001   │ │  002   │ │  003   │ │  00N   │        │
│  │ agent  │ │ agent  │ │ agent  │ │ agent  │        │
│  └────────┘ └────────┘ └────────┘ └────────┘        │
└────────────────────────────────────────────────────────┘
```

### Implementation (Works Today)

```typescript
const API = "http://127.0.0.1:8080/api/v1";
const FLEET_SIZE = 5;
const TASKS = ["fix-auth.md", "add-tests.md", "refactor-db.md", "fix-css.md", "add-api.md"];

// Helper
async function apiPost(path: string, body?: unknown) {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function exec(name: string, cmd: string, opts?: { env?: {name: string, value: string}[], timeout?: number }) {
  const resp = await apiPost(`/machines/${name}/exec`, {
    command: ["sh", "-c", cmd],
    env: opts?.env,
    timeout_secs: opts?.timeout ?? 300,
  });
  return resp.json();
}

// Create fleet
for (let i = 0; i < FLEET_SIZE; i++) {
  await apiPost("/machinees", {
    name: `agent-${i}`,
    resources: { cpus: 2, memory_mb: 2048, network: true },
  });
}

// Start all (parallel)
await Promise.all(
  Array.from({ length: FLEET_SIZE }, (_, i) =>
    apiPost(`/machines/agent-${i}/start`)
  )
);

// Bootstrap all (parallel)
await Promise.all(
  Array.from({ length: FLEET_SIZE }, (_, i) =>
    exec(`agent-${i}`, "apk add --no-cache git nodejs npm", { timeout: 60 })
  )
);

// Run tasks (parallel — cross-machine exec is truly parallel)
const results = await Promise.all(
  TASKS.map((task, i) =>
    exec(`agent-${i}`, `echo "Working on: ${task}" && node agent.js`, {
      env: [
        { name: "ANTHROPIC_API_KEY", value: Deno.env.get("ANTHROPIC_API_KEY")! },
        { name: "TASK_FILE", value: task },
      ],
      timeout: 600,
    })
  )
);

// Collect results
for (let i = 0; i < FLEET_SIZE; i++) {
  const output = await exec(`agent-${i}`, "cat /workspace/result.json");
  console.log(`Agent ${i}:`, output.stdout);
}

// Cleanup
for (let i = 0; i < FLEET_SIZE; i++) {
  await apiPost(`/machines/agent-${i}/stop`);
  await fetch(`${API}/machines/agent-${i}`, { method: "DELETE" });
}
```

This is ~60 lines of TypeScript using just `fetch()` — no SDK needed.

---

## 6. Resource Planning

### Per-Agent Machine

| Resource | Allocation | Notes |
|----------|-----------|-------|
| CPU | 2 cores | Agent + test execution |
| Memory | 2048 MB | Node.js + git ops |
| Disk | ~1 GB | Tools + workspace |
| Network | TCP/UDP | npm, Anthropic API, GitHub |

### Host Requirements

| Agents | CPU Cores | RAM | Disk |
|--------|----------|-----|------|
| 1 | 2 | 2 GB | 1 GB |
| 3 | 6 | 6 GB | 3 GB |
| 5 | 10 | 10 GB | 5 GB |
| 10 | 20 | 20 GB | 10 GB |

Mac Studio M2 Ultra (24 CPU, 192 GB): ~10 concurrent agents.
MacBook Pro M3 Max (16 CPU, 128 GB): ~7 concurrent agents.

---

## 7. Gotchas

1. **`sh --version` hangs on Alpine** — busybox doesn't support `--version`,
   starts interactive shell. Use `which sh && echo available` instead.

2. **Always use `timeout_secs`** — exec calls without timeout can hang
   indefinitely if a command blocks.

3. **Exec format** — use `["sh", "-c", "complex command"]` for shell syntax
   (pipes, &&, $VAR). Use `["echo", "hello"]` for simple commands.

4. **Within-machine exec is serial** — if you need parallel work, use
   multiple machinees.

5. **Alpine has nothing** — no node, python, git, curl. Budget 7s for
   bootstrap or use a pre-built OCI image.

6. **Stop is slow** — ~2.2s to stop a machine. Factor this into lifecycle
   calculations.

7. **Volume mounts are buggy** — don't rely on them. Use exec-based file
   I/O workarounds.
