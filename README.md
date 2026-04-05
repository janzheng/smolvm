# smolvm

A small computer for agents. Each sandbox is an isolated micro VM with its own filesystem, network, and tools. Push code in, work on it, pull results out. Fork, snapshot, merge — like git, but for entire machines.

Built on [smolvm](https://smolmachines.com) (libkrun micro VMs). Runs locally on macOS (Apple Silicon) or Linux (KVM). Access remotely via Cloudflare tunnel + bearer token auth.

See [docs/](docs/) for architecture and design documentation.

## Quick Start

```bash
# Start the server
smolvm serve start --listen 127.0.0.1:9090

# Spin up a sandbox
deno task ctl up my-vm

# Run commands
deno task ctl sh my-vm "apk add git nodejs npm"
deno task ctl sh my-vm "node --version"

# Copy files in and out
deno task ctl cp ./my-project my-vm:/workspace/my-project
deno task ctl sh my-vm "cd /workspace/my-project && npm test"
deno task ctl cp my-vm:/workspace/my-project/dist ./dist

# Clone, diff, merge
deno task ctl clone my-vm my-vm-fork
deno task ctl diff my-vm my-vm-fork
deno task ctl merge my-vm-fork my-vm

# Clean up
deno task ctl down my-vm
```

## What's Here

```
server/            The smolvm server (our fork — security hardening, auth, snapshots)
sdk-ts/            TypeScript SDK (used by Brigade, smolctl, tests)
cli/smolctl.ts     CLI for managing sandboxes (deno task ctl)
tests/             TypeScript SDK test suites (deno task test-*)
playtests/         Agentic playtest scripts (e2e-playtest.sh)
starters/          Smolfile templates (node, python, openclaw)
docs/              API reference, security docs, research
mcp-servers/       MCP server configs for sandboxed tools
deploy/            Deployment configs
.references/       Legacy code (gitignored, local-only)
```

## smolctl CLI

Full sandbox management via `deno task ctl <command>`:

| Command | Description |
|---|---|
| `up/down <name>` | Create+start / stop+delete |
| `ls` | List sandboxes |
| `sh <name> <cmd>` | Run shell command |
| `exec <name> <cmd...>` | Run command (no shell) |
| `cp <src> <dst>` | Copy files in/out (`./local vm:/remote`) |
| `git clone <name> <url>` | Clone repo inside sandbox |
| `clone/diff/merge` | Git-like VM workflows |
| `snapshot push/pull/ls/rm/export/import/merge/lineage/squash` | Full snapshot management |
| `image pull/ls` | OCI image management |
| `run <name> <img> <cmd>` | Run in OCI overlay |
| `files ls/cat/write/rm` | File operations |
| `sync push/pull <name>` | Push/pull dirs (`--to /remote`, `--exclude`, `--dry-run`) |
| `container ls/create/start/stop/rm/exec` | Manage containers inside sandbox |
| `agent run/fleet/worker` | Run Claude Code agents in sandboxes |
| `auth login/status/logout` | Claude subscription auth (OAuth) |
| `job submit/ls/claim` | Work queue for agent tasks |
| `mcp servers/tools/call` | MCP server integration |
| `pool add/ls/rm/status` | Multi-node pool management |
| `starter init/validate/ls/export/import` | Custom starter templates |
| `dashboard` | Interactive TUI dashboard |
| `tunnel start/stop` | Cloudflare/ngrok tunnel management |
| `debug mounts/network` | Diagnostic info for troubleshooting |
| `prune` | Delete all sandboxes |
| `health` | Server health check |

Exec flags: `--env KEY=VALUE`, `--workdir /path`, `--user <name>`, `--timeout <secs>`

## Remote Access

```bash
# Quick way (via smolctl — handles cloudflared lifecycle)
smolctl tunnel start          # Starts cloudflared, prints public URL
smolctl tunnel status         # Shows URL + PID
smolctl tunnel stop           # Kills cloudflared

# Manual way
smolvm serve start --listen 127.0.0.1:9090 --generate-token
cloudflared tunnel --url http://localhost:9090

# From anywhere
export SMOLVM_URL=https://your-tunnel.trycloudflare.com
export SMOLVM_API_TOKEN=<token>
deno task ctl ls
```

Requires `cloudflared` (`brew install cloudflared`). See [docs/TUNNEL.md](docs/TUNNEL.md) for the full setup guide.

## Running Tests

### server integration tests (shell scripts, no server needed)

```bash
cd server && ./tests/run_all.sh          # All 125 tests (6 suites)
cd server && ./tests/run_all.sh sandbox   # Individual suite
cd server && cargo test                   # Rust unit tests (200+)
```

### E2E playtests (need running server + smolctl)

```bash
# Start server first (use cargo-make for correct env vars)
cd server && cargo make smolvm serve start
# Or manually: DYLD_LIBRARY_PATH=./lib ./target/release/smolvm serve start

# Run playtests (in a separate terminal)
bash playtests/e2e-playtest.sh
```

Results: 80 pass, 0 fail, 1 skip (dashboard — needs interactive terminal).
Results get appended to `playtests/PLAYTEST-LOG.md`.

For agent tests (PT-7), authenticate first: `smolctl auth login` (see [Claude Code Auth](#claude-code-auth)).
For tunnel tests (PT-10), install cloudflared: `brew install cloudflared`.

### TypeScript SDK tests (need running server)

```bash
smolvm serve start --listen 127.0.0.1:9090

deno task test-all          # All suites
deno task test              # Sandbox basics
deno task test-capabilities # Full capability matrix
deno task test-fleet        # Multi-sandbox parallelism
deno task test-isolation    # Security + isolation
deno task test-containers   # Container lifecycle + debug
deno task test-sync         # Sync push/pull
```

With auth: `SMOLVM_API_TOKEN=<token> deno task test-all`

## Claude Code Auth

`smolctl agent run` launches Claude Code inside a sandbox. Two auth methods:

**Option 1 — Claude subscription (recommended):**
```bash
smolctl auth login
```
Opens a browser, authenticates via Claude.ai OAuth (PKCE flow), and saves tokens to the project `.env` (next to `cli/`). Uses your Claude subscription — no API key needed. Tokens auto-refresh.

**Option 2 — API key:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or add to .env
```

The agent run command uses subscription mode by default. Claude Code runs in `--settings` mode inside the sandbox so it can accept permissions headlessly.

## Performance

| Metric | Result |
|---|---|
| Create | 6-14ms |
| Boot | 258-805ms |
| First exec | 12-15ms |
| Warm exec | 12ms |
| Fleet (3 parallel) | 82ms/sandbox |

## Security

- Bearer token auth on all `/api/v1/*` routes (`--api-token` or `--generate-token`)
- Non-root exec via setuid/setgid
- Fork bomb protection (RLIMIT_NPROC)
- Health/metrics/SwaggerUI stay public

## Known Upstream Bugs

These need fixes in smolvm/libkrun:

- **Port mapping** connections refused (use tunnels instead)
- **Container-in-sandbox** 500 error
- **VM can reach host API** via TSI (mitigated by auth token)
- ~~**Stale overlay rootfs from sandbox run**~~ Fixed in upstream #41 (synced)

## Notes for AI Agents

Common pitfalls when working on this project:

### Directory layout

- **`server/`** — Our fork of smolvm. This is where you build, test, and modify the Rust source. Synced with upstream + our extensions (API server, auth, snapshots, etc.)
- **`cli/smolctl.ts`** — The TypeScript CLI that wraps the HTTP API. Run with `deno run -A cli/smolctl.ts`.
- **`.references/`** — Legacy/experimental code (gitignored). Upstream reference copy, old prototypes. Do NOT modify.

### Building server

Always use `cargo make` — it handles `DYLD_LIBRARY_PATH`, `SMOLVM_AGENT_ROOTFS`, and codesigning automatically:
```bash
cd server
cargo make dev                    # build + codesign
cargo make smolvm serve start     # run with correct env vars
cargo make smolvm sandbox run --net alpine -- echo hello
```

Running the binary directly without `DYLD_LIBRARY_PATH=./lib` will fail silently or with a cryptic dylib error. Do NOT use `cargo run` for the server — it doesn't set the library path.

### Three test layers (don't confuse them)

| Layer | Command | Needs server? | Needs VM env? | Count |
|-------|---------|---------------|---------------|-------|
| Rust unit tests | `cd server && cargo test` | No | No | 200+ |
| Shell integration | `cd server && ./tests/run_all.sh` | No | Yes (Hypervisor.framework / KVM) | 125 |
| E2E playtests | `bash playtests/e2e-playtest.sh` | **Yes** (server must be running) | Yes | 73 |

For the E2E playtests, start the server in one terminal, run playtests in another.

### Server commands

- Start: `smolvm serve start` (NOT `smolvm serve`)
- The server listens on `127.0.0.1:9090` by default
- With auth: `smolvm serve start --generate-token`

### Claude Code in sandboxes

Uses **subscription mode** (OAuth), not API keys by default. Authenticate with `smolctl auth login` — opens browser, saves tokens to the project `.env`. Claude Code runs with `--settings` flag inside the sandbox for headless permission acceptance. See `.env.example` for all auth options.

### VM storage architecture

- Each VM gets its own ext4 disk at `/dev/vda`, mounted at `/storage/workspace`
- Overlay rootfs means `/` is writable but changes are per-VM
- Snapshots capture the overlay + workspace disk
- `exitCode` (camelCase) in API responses, not `exit_code`
