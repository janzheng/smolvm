# smolvm User Guide

A small computer for agents. Each sandbox is an isolated micro VM — its own
filesystem, network, and tools. Push code in, work on it, pull results out.
Fork, snapshot, merge — like git, but for entire machines.

## Table of Contents

- [Setup](#setup)
- [Your First Sandbox](#your-first-sandbox)
- [Files & Folders](#files--folders)
- [Snapshots](#snapshots)
- [Clone, Diff, Merge](#clone-diff-merge)
- [Fleet (Parallel Sandboxes)](#fleet-parallel-sandboxes)
- [Running Agents](#running-agents)
- [Secrets](#secrets)
- [Remote Access](#remote-access)
- [Web Dashboard](#web-dashboard)
- [MCP Servers](#mcp-servers)
- [Jobs & Workers](#jobs--workers)
- [Tips & Patterns](#tips--patterns)
- [Command Reference](#command-reference)

---

## Setup

### Prerequisites

- macOS (Apple Silicon) or Linux (KVM)
- Deno 2+ (`brew install deno`)
- smolvm binary built and codesigned (see README.md build recipe)

### Start the Server

```bash
# Basic (no auth, local only)
smolvm serve start

# With auth (recommended)
smolvm serve start --generate-token

# With web dashboard
smolvm serve start --web-ui ./web-ui

# With secrets for agent API access
smolvm serve start --secret anthropic=sk-ant-xxx --secret openai=sk-xxx
```

The server runs on `http://127.0.0.1:8080` by default. Change with `-l 0.0.0.0:9000`.

### CLI Alias

All CLI commands go through `deno task ctl`. For convenience:

```bash
alias smolctl="deno task ctl"
```

The rest of this guide uses `smolctl` for brevity.

---

## Your First Sandbox

### Create and Start

```bash
# One command — create + start + wait for boot
smolctl up my-vm

# With options
smolctl up my-vm --cpus 4 --memory 2048

# From a starter template (pre-configured environment)
smolctl up my-vm --starter claude-code
smolctl up my-vm --starter node-deno
smolctl up my-vm --starter python-ml
```

### Run Commands

```bash
# Shell command (interpreted by sh)
smolctl sh my-vm "apk add git nodejs npm"
smolctl sh my-vm "echo hello > /workspace/hello.txt"

# Direct exec (no shell — for precise argument passing)
smolctl exec my-vm -- node -e "console.log('hi')"

# With environment variables
smolctl sh my-vm "echo \$MY_VAR" --env MY_VAR=hello

# With working directory
smolctl sh my-vm "npm test" --workdir /workspace/my-project

# With timeout (default 30s)
smolctl sh my-vm "npm run build" --timeout 120
```

### Check Status

```bash
smolctl ls                 # List all sandboxes
smolctl info my-vm         # Detailed JSON info
smolctl stats my-vm        # CPU, memory, disk usage
smolctl logs my-vm         # Stream stdout/stderr
```

### Stop and Delete

```bash
smolctl stop my-vm         # Stop (keeps state)
smolctl start my-vm        # Start again (state preserved)
smolctl rm my-vm           # Delete permanently
smolctl down my-vm         # Stop + delete in one step (with safety checks)
smolctl down my-vm --force # Skip safety checks
```

---

## Files & Folders

### Copy Files In and Out

```bash
# Local → sandbox
smolctl cp ./my-file.txt my-vm:/workspace/my-file.txt
smolctl cp ./my-folder my-vm:/workspace/my-folder

# Sandbox → local
smolctl cp my-vm:/workspace/output.txt ./output.txt
smolctl cp my-vm:/workspace/results ./results
```

### Browse Files Inside a Sandbox

```bash
smolctl files ls my-vm /workspace
smolctl files cat my-vm /workspace/config.json
smolctl files write my-vm /workspace/config.json --data '{"key": "value"}'
smolctl files rm my-vm /workspace/temp.log
```

### Sync Directories (Bidirectional)

For ongoing development — sync a local directory with a sandbox:

```bash
# Push local dir into sandbox
smolctl sync push my-vm ./src --to /workspace/src --exclude node_modules --exclude .git

# Pull sandbox dir to local
smolctl sync pull my-vm --from /workspace/output --to ./output

# Watch mode — auto-push on local changes
smolctl sync watch my-vm ./src --to /workspace/src --exclude node_modules

# Dry run — see what would be synced
smolctl sync push my-vm ./src --to /workspace/src --dry-run
```

---

## Snapshots

Snapshots are portable archives of a sandbox's entire state. Like git commits,
but for whole machines.

### Push (Save) a Snapshot

```bash
smolctl snapshot push my-vm --desc "after npm install"
```

This creates a `.smolvm` archive in `~/Library/Application Support/smolvm/snapshots/`.

### List Snapshots

```bash
smolctl snapshot ls
```

### Pull (Restore) a Snapshot

```bash
smolctl snapshot pull my-vm-snapshot new-vm
smolctl start new-vm
```

### Snapshot History and Rollback

```bash
# See all versions
smolctl snapshot history my-vm

# Roll back to a specific version
smolctl snapshot rollback my-vm restored-vm --version 2

# Squash versions into one (saves disk)
smolctl snapshot squash my-vm
```

### Incremental Snapshots

After the first push, use `--incremental` to only store what changed:

```bash
smolctl snapshot push my-vm --desc "v1 base"
# ... make changes ...
smolctl snapshot push my-vm --incremental --desc "v2 added tests"
```

### Move Snapshots Between Machines

```bash
# Export to a file you can share (Dropbox, USB, etc.)
smolctl snapshot export my-vm ~/Desktop/my-vm.smolvm

# Import on another machine
smolctl snapshot import ~/Desktop/my-vm.smolvm my-vm
smolctl snapshot pull my-vm new-vm
```

### Remote Transfer (Between Servers)

```bash
# Configure a remote provider
smolctl provider add my-vps http://my-server:8080 --token TOKEN

# Upload snapshot to remote
smolctl --provider my-vps snapshot upload my-vm

# Download from remote
smolctl --provider my-vps snapshot download my-vm

# List remote snapshots
smolctl snapshot ls --remote --provider my-vps
```

### Workspace Export (Lightweight)

When you just need the code, not the whole VM:

```bash
# Export just /workspace as tar.gz (~14KB vs ~100MB full snapshot)
smolctl snapshot export-workspace my-vm ./workspace.tar.gz

# Import workspace into a different sandbox
smolctl snapshot import-workspace ./workspace.tar.gz other-vm
```

### Browse Snapshot Contents Without Restoring

```bash
smolctl snapshot ls-files my-vm /workspace --recursive
smolctl snapshot cp my-vm:/workspace/package.json ./package.json
```

### Convert to Docker

```bash
smolctl snapshot to-docker my-vm --tag my-app:latest
# Creates a Dockerfile + build context in ./docker-export/
docker build -t my-app:latest ./docker-export/
```

---

## Clone, Diff, Merge

Git-like workflows for entire VMs.

### Clone

```bash
# Create a copy (uses APFS CoW — instant, near-zero disk)
smolctl clone my-vm my-vm-fork
```

### Diff

```bash
# Compare workspaces between two sandboxes
smolctl diff my-vm my-vm-fork

# Or using git diff (line-level)
smolctl git diff my-vm my-vm-fork
```

### Merge

```bash
# Three-way merge (like git merge)
smolctl git merge my-vm-fork my-vm

# With conflict resolution strategy
smolctl git merge my-vm-fork my-vm --strategy theirs
smolctl git merge my-vm-fork my-vm --strategy ours
```

### Git Inside Sandboxes

Every sandbox has a git-initialized workspace at `/workspace`:

```bash
smolctl git status my-vm
smolctl git log my-vm
smolctl git commit my-vm -m "save progress"
```

---

## Fleet (Parallel Sandboxes)

Run the same task across many sandboxes at once.

### Create a Fleet

```bash
# Create 5 sandboxes named worker-0 through worker-4
smolctl fleet up worker 5 --cpus 2 --memory 1024
```

### Run Commands on All

```bash
smolctl fleet exec worker "npm test"
smolctl fleet ls worker
```

### Fan Out and Gather (Fork-Join Pattern)

```bash
# Fork: clone a sandbox into 3 copies, each on its own git branch
smolctl fleet fanout my-vm 3

# Each copy works independently...
smolctl sh my-vm-0 "implement feature A"
smolctl sh my-vm-1 "implement feature B"
smolctl sh my-vm-2 "implement feature C"

# Gather: merge all forks back into one sandbox
smolctl fleet gather my-vm --into my-vm-merged
```

### Tear Down

```bash
smolctl fleet down worker
```

---

## Running Agents

Run Claude Code (or other AI agents) inside sandboxes with controlled
permissions.

### Basic Agent Run

```bash
smolctl agent run "Build a React todo app with tests" \
  --starter claude-code \
  --sandbox permissive \
  --secret anthropic \
  --timeout 300
```

### Permission Presets

```bash
# See available presets
smolctl sandbox ls

# Check what a preset allows
smolctl sandbox show permissive
smolctl sandbox show developer
smolctl sandbox show research

# Test if a tool is allowed
smolctl sandbox test developer "Bash(git push --force)"
```

| Preset | Description |
|--------|-------------|
| `permissive` | Auto-approve all non-destructive tools |
| `developer` | Everything except destructive git ops |
| `research` | Web + files only, no git or system commands |

### Multi-Agent Fleet

```bash
# Run multiple agents from a prompts file
smolctl agent fleet agents prompts.txt \
  --sandbox developer \
  --starter claude-code \
  --secret anthropic

# Collect all agent workspaces when done
smolctl agent collect agents ./results
```

---

## Secrets

Secrets are injected into sandboxes via a reverse proxy — the actual API key
never enters the VM. The VM sees a local proxy endpoint instead.

### Register Secrets

```bash
# At server start
smolvm serve start --secret anthropic=sk-ant-xxx --secret openai=sk-xxx

# Or via environment variables
export SMOLVM_SECRET_ANTHROPIC=sk-ant-xxx
smolvm serve start
```

### Use in Sandboxes

```bash
# Create sandbox with secret access
smolctl up my-vm --secret anthropic

# Inside the VM, API calls to Anthropic are automatically proxied
# The VM never sees the real key
```

### Manage at Runtime

```bash
smolctl secret ls
smolctl secret update --secret anthropic=sk-ant-NEW-KEY
```

---

## Remote Access

Access your sandboxes from anywhere via Cloudflare tunnel.

### Quick Setup

```bash
# On your machine
smolvm serve start --generate-token
smolctl tunnel start

# From anywhere
export SMOLVM_URL=https://your-tunnel.trycloudflare.com
export SMOLVM_API_TOKEN=<token>
smolctl ls
```

### Provider Configuration

For persistent remote servers:

```bash
smolctl provider add my-vps http://my-server:8080 --token TOKEN
smolctl provider use my-vps
smolctl ls  # now talks to remote server
```

See [docs/TUNNEL.md](TUNNEL.md) for the full tunnel setup guide.

---

## Web Dashboard

The server can serve a web dashboard alongside the API.

```bash
smolvm serve start --web-ui ./web-ui
# Dashboard at http://localhost:8080/
# API at http://localhost:8080/api/v1/
# Swagger docs at http://localhost:8080/swagger-ui/
```

Features:
- Live sandbox list with status indicators
- Interactive terminal (ghostty-web) — open a shell in any sandbox
- Create, start, stop, delete sandboxes from the browser

There's also a terminal dashboard:

```bash
smolctl dashboard
```

---

## MCP Servers

Model Context Protocol servers give agents structured tool access to the
sandbox filesystem, exec, and git.

### Install and Use

```bash
# Auto-install built-in MCP servers on create
smolctl up my-vm --with-mcp

# List available tools (18 across 3 servers)
smolctl mcp tools my-vm

# Call a tool
smolctl mcp call my-vm filesystem read_file '{"path":"/workspace/README.md"}'
smolctl mcp call my-vm exec run_command '{"command":"npm test"}'
smolctl mcp call my-vm git status '{}'
```

### Built-in Servers

| Server | Tools |
|--------|-------|
| `filesystem` | read_file, write_file, list_directory, create_directory, delete_file, move_file |
| `exec` | run_command, run_script, get_env, set_env, which |
| `git` | status, log, diff, add, commit, branch, checkout |

---

## Jobs & Workers

A work queue for distributing tasks to sandbox workers.

### Submit and Monitor Jobs

```bash
# Submit a job
smolctl job submit my-vm "npm test" --priority 10 --timeout 120

# List jobs
smolctl job ls

# Watch a job
smolctl job watch <job-id>
```

### Worker Mode

Run a sandbox as a worker that polls for jobs:

```bash
smolctl agent worker --reuse my-vm --max-jobs 10
```

---

## Tips & Patterns

### Development Loop

```bash
smolctl up dev --starter node-deno
smolctl sync watch dev ./src --to /workspace/src --exclude node_modules
# Edit locally, tests run in sandbox
smolctl sh dev "cd /workspace/src && npm test"
```

### Checkpoint and Experiment

```bash
smolctl snapshot push my-vm --desc "before risky change"
smolctl sh my-vm "rm -rf /workspace/node_modules && npm install"
# Didn't work? Roll back:
smolctl snapshot rollback my-vm my-vm --version 1
```

### Parallel Testing

```bash
smolctl fleet fanout my-vm 3
smolctl sh my-vm-0 "cd /workspace && npm test -- --shard=1/3"
smolctl sh my-vm-1 "cd /workspace && npm test -- --shard=2/3"
smolctl sh my-vm-2 "cd /workspace && npm test -- --shard=3/3"
smolctl fleet down my-vm
```

### Share a Snapshot with a Colleague

```bash
# You: export to Dropbox
smolctl snapshot export my-vm ~/Dropbox/my-vm.smolvm

# Colleague: import and boot
smolctl snapshot import ~/Dropbox/my-vm.smolvm my-vm
smolctl snapshot pull my-vm colleague-vm
smolctl start colleague-vm
```

### Install Packages

Sandboxes run Alpine Linux. Use `apk` for system packages:

```bash
smolctl sh my-vm "apk add git nodejs npm python3 py3-pip curl jq"
```

Or use `--init` to install on create:

```bash
smolctl up my-vm --init "apk add nodejs npm" --init "npm install -g typescript"
```

### Post-Start Setup

The `--setup` flag on `up` runs commands after the sandbox boots:

```bash
smolctl up my-vm --setup "apk add git" --setup "git clone https://github.com/me/repo /workspace/repo"
```

---

## Command Reference

### Sandbox Lifecycle

| Command | Description |
|---------|-------------|
| `up <name> [flags]` | Create + start (one shot) |
| `down <name> [--force]` | Stop + delete (with safety checks) |
| `create <name> [flags]` | Create only |
| `start <name>` | Start a stopped sandbox |
| `stop <name>` | Stop a running sandbox |
| `rm <name> [--force]` | Delete a sandbox |
| `ls` | List all sandboxes |
| `info <name>` | Detailed sandbox info (JSON) |
| `prune` | Delete ALL sandboxes |
| `resume <name>` | Reconnect to cached sandbox |

### Execution

| Command | Description |
|---------|-------------|
| `sh <name> <cmd>` | Run shell command |
| `exec <name> [--] <cmd...>` | Run command directly |
| `run <name> <image> <cmd...>` | Run in OCI container overlay |
| `logs <name>` | Stream sandbox output |

### Files

| Command | Description |
|---------|-------------|
| `cp <src> <dst>` | Copy files/folders in or out |
| `files ls <name> [dir]` | List files |
| `files cat <name> <path>` | Read file |
| `files write <name> <path>` | Write file |
| `files rm <name> <path>` | Delete file |
| `sync push <name> [dir]` | Push local dir to sandbox |
| `sync pull <name> [dir]` | Pull sandbox dir to local |
| `sync watch <name> [dir]` | Watch and auto-push |

### Snapshots

| Command | Description |
|---------|-------------|
| `snapshot push <name>` | Save sandbox as snapshot |
| `snapshot pull <snap> <name>` | Restore snapshot to new sandbox |
| `snapshot ls` | List snapshots |
| `snapshot rm <name>` | Delete snapshot |
| `snapshot describe <name>` | Show metadata |
| `snapshot history <name>` | Show version history |
| `snapshot rollback <snap> <name>` | Restore specific version |
| `snapshot squash <name>` | Compact versions |
| `snapshot export <name> [path]` | Export to portable file |
| `snapshot import <path> [name]` | Import from file |
| `snapshot upload <name>` | Upload to remote provider |
| `snapshot download <name>` | Download from remote |
| `snapshot export-workspace` | Export just /workspace |
| `snapshot import-workspace` | Import workspace archive |
| `snapshot to-docker <name>` | Convert to Docker build context |
| `snapshot cp <src> <dst>` | Copy files in/out of snapshot |
| `snapshot ls-files <snap>` | Browse snapshot contents |
| `snapshot merge <snap> <vm>` | Merge snapshot into running VM |
| `snapshot lineage <name>` | Show snapshot ancestry |

### Clone/Diff/Merge

| Command | Description |
|---------|-------------|
| `clone <name> <new>` | Clone sandbox (CoW) |
| `diff <name> <other>` | Compare sandboxes |
| `merge <source> <target>` | Merge sandboxes |
| `git status/log/commit/init` | Git inside sandbox |
| `git diff <src> <tgt>` | Line-level diff |
| `git merge <src> <tgt>` | Three-way merge |

### Fleet

| Command | Description |
|---------|-------------|
| `fleet up <prefix> <N>` | Create N sandboxes |
| `fleet down <prefix>` | Delete all with prefix |
| `fleet ls [prefix]` | List fleet members |
| `fleet exec <prefix> <cmd>` | Run on all |
| `fleet fanout <src> <N>` | Clone into N copies |
| `fleet gather <prefix> --into <tgt>` | Merge all back |

### Agent

| Command | Description |
|---------|-------------|
| `agent run "<prompt>"` | Run Claude Code in sandbox |
| `agent fleet <prefix> <file>` | Multi-agent from prompts file |
| `agent worker` | Worker mode (polls for jobs) |
| `agent collect <prefix>` | Download all agent results |

### Create/Up Flags

| Flag | Description |
|------|-------------|
| `--cpus <n>` | CPU count (default: 2) |
| `--memory <mb>` | Memory in MB (default: 1024) |
| `--no-network` | Disable networking |
| `--init <cmd>` | Init command (repeatable) |
| `--setup <cmd>` | Post-start command (repeatable, `up` only) |
| `--user <name>` | Default non-root user |
| `--starter <name>` | Use starter template |
| `--secret <name>` | Inject secret (repeatable) |
| `--with-mcp` | Auto-install MCP servers |
| `--label key=value` | Metadata label (repeatable) |
| `--allowed-domains <dom>` | DNS egress filter (repeatable) |

### Exec Flags

| Flag | Description |
|------|-------------|
| `--env KEY=VALUE` | Set environment variable (repeatable) |
| `--workdir /path` | Working directory |
| `--user <name>` | Run as user |
| `--timeout <secs>` | Timeout (default: 30) |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SMOLVM_URL` | Server URL (default: `http://127.0.0.1:8080`) |
| `SMOLVM_API_TOKEN` | Bearer token for auth |

---

## Performance

| Metric | Result |
|--------|--------|
| Create | 6-14ms |
| Boot | 258-805ms |
| First exec | 12-15ms |
| Warm exec | 12ms |
| Fleet (3 parallel) | 82ms/sandbox |
| Snapshot push | 8-22s |
| Snapshot pull | ~21s |

---

## Known Limitations

- **Volume mounts** don't work in guest (use `smolctl cp` or `sync` instead)
- **Port mapping** connections refused (use tunnels instead)
- **Domain allowlists** code ready but not enforced (upstream libkrun blocker)
- **macOS only** for now on Apple Silicon; Linux KVM also supported
- Sandboxes run **Alpine Linux** (musl libc — some glibc-only binaries won't work)
