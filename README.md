<p align="center">
  <img src="assets/logo.png" alt="smol machines" width="80">
</p>

<p align="center">
  <a href="https://discord.gg/qhQ7FHZ2zd"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/smol-machines/smolvm/releases"><img src="https://img.shields.io/github/v/release/smol-machines/smolvm?label=Release" alt="Release"></a>
  <a href="https://github.com/smol-machines/smolvm/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License"></a>
</p>

smolvm
======

A local tool to build and run portable, lightweight, self-contained virtual machines.

Each workload runs in its own Linux microVM with a separate kernel. The host
filesystem, network, and credentials are isolated unless explicitly shared.

Quick Start
-----------

* Install: [GitHub Releases](https://github.com/smol-machines/smolvm/releases) or `curl -sSL https://smolmachines.com/install.sh | bash`
* Documentation: https://smolmachines.com/sdk/
* Report a bug: https://github.com/smol-machines/smolvm/issues
* Join the community: https://discord.gg/qhQ7FHZ2zd

```bash
# Run a container image in an isolated microVM
smolvm sandbox run --net alpine -- echo "hello from a microVM"

# Mount host directories (explicit — host is protected by default)
smolvm sandbox run --net -v ./src:/workspace alpine -- ls /workspace

# Persistent microVM with interactive shell
smolvm microvm create --net myvm
smolvm microvm start myvm
smolvm microvm exec --name myvm -- apk add sl
smolvm microvm exec --name myvm -it -- sl
smolvm microvm exec --name myvm -it -- /bin/sh   # interactive shell
smolvm microvm stop myvm

# Pack into a portable executable
smolvm pack create python:3.12-alpine -o ./my-pythonvm
./my-pythonvm python3 -c "print('hello from a packed VM')"
```

How It Works
------------

[libkrun](https://github.com/containers/libkrun) VMM with
[Hypervisor.framework](https://developer.apple.com/documentation/hypervisor) (macOS)
or KVM (Linux). No daemon — the VMM is a library linked into the binary.
Custom kernel: [libkrunfw](https://github.com/smol-machines/libkrunfw).

* <200ms boot
* Single binary, no runtime dependencies
* Runs OCI container images inside microVMs
* Packs workloads into portable `.smolmachine` executables
* Embeddable via Node.js and Python SDKs

Comparison
----------

|                     | smolvm | Containers | Colima | QEMU | Firecracker | Kata |
|---------------------|--------|------------|--------|------|-------------|------|
| Isolation           | VM per workload | Namespace (shared kernel) | Namespace (1 VM) | Separate VM | Separate VM | VM per container |
| Boot time           | <200ms | ~100ms | ~seconds | ~15-30s | <125ms | ~500ms |
| Architecture        | Library (libkrun) | Daemon | Daemon (in VM) | Process | Process | Runtime stack |
| Per-workload VMs    | Yes | No | No (shared) | Yes | Yes | Yes |
| macOS native        | Yes | Via Docker VM | Yes (krunkit) | Yes | No | No |
| Embeddable SDK      | Yes | No | No | No | No | No |
| Portable artifacts  | `.smolmachine` | Images (need daemon) | No | No | No | No |

Platform Support
----------------

| Host | Guest | Requirements |
|------|-------|-------------|
| macOS Apple Silicon | arm64 Linux | macOS 11+ |
| macOS Intel | x86_64 Linux | macOS 11+ (untested) |
| Linux x86_64 | x86_64 Linux | KVM (`/dev/kvm`) |
| Linux aarch64 | aarch64 Linux | KVM (`/dev/kvm`) |

Known Limitations
-----------------

* Network is opt-in for sandboxes (`--net`). Default microVM has networking enabled. TCP/UDP only, no ICMP.
* Volume mounts: directories only (no single files).
* macOS: binary must be signed with Hypervisor.framework entitlements.

Development
-----------

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

> Alpha — APIs may change.

We use [`cargo-make`](https://github.com/sagiegurari/cargo-make) to orchestrate build tasks:

```bash
# Install cargo-make (one-time)
cargo install cargo-make

# View all available tasks
cargo make --list-all-steps

# Build and codesign (macOS) - binary ready at ./target/release/smolvm
cargo make dev

# Run smolvm with environment variables set up automatically
cargo make smolvm --version
cargo make smolvm sandbox run --net alpine:latest -- echo hello
cargo make smolvm microvm ls

# Or run the binary directly with environment variables:
DYLD_LIBRARY_PATH="./lib" SMOLVM_AGENT_ROOTFS="./target/agent-rootfs" ./target/release/smolvm <command>
```

**How it works:**
- `cargo make dev` → builds + codesigns (macOS only), binary ready at `./target/release/smolvm`
- `cargo make smolvm <args>` → runs smolvm with `DYLD_LIBRARY_PATH` and `SMOLVM_AGENT_ROOTFS` set up
- On macOS, binary is automatically signed with hypervisor entitlements

### Building Distribution Packages

```bash
# Build distribution package
cargo make dist

# Build using local libkrun changes from ../libkrun
./scripts/build-dist.sh --with-local-libkrun
```

### Running Tests

```bash
# Run all tests
cargo make test

# Run specific test suites
cargo make test-cli        # CLI tests only
cargo make test-sandbox    # Sandbox tests only
cargo make test-microvm    # MicroVM tests only
cargo make test-pack       # Pack tests only
cargo make test-lib        # Unit tests (no VM required)
```

### Agent Rootfs Development

The agent rootfs resolution order is:
1. `SMOLVM_AGENT_ROOTFS` env var (explicit override)
2. `./target/agent-rootfs` (local development)
3. Platform data directory (`~/.local/share/smolvm/` on Linux, `~/Library/Application Support/smolvm/` on macOS)

```bash
# Build agent for Linux (size-optimized)
cargo make build-agent

# Build agent rootfs
cargo make agent-rootfs

# Rebuild agent and update rootfs
cargo make agent-rebuild
```

### Code Quality

```bash
# Run clippy and fmt checks
cargo make lint

# Auto-fix linting issues
cargo make fix-lints
```

### Other Useful Tasks

```bash
# Install locally from dist package
cargo make install
```

### Distribution Scripts

The `cargo make dist` task wraps `scripts/build-dist.sh`. Other scripts you can run directly:

```bash
./scripts/build-dist.sh
./scripts/build-agent-rootfs.sh
./scripts/install-local.sh
```

### troubleshooting tests

**Database lock errors** ("Database already open"):
```bash
pkill -f "smolvm serve"
pkill -f "smolvm-bin microvm start"
```

**Hung tests**: Check for stuck VM processes:
```bash
ps aux | grep smolvm
```

---

## smolvm-plus extensions

This fork ([janzheng/smolvm](https://github.com/janzheng/smolvm), branch `smolvm-plus`) adds experimental agent infrastructure on top of upstream smolvm. Synced with upstream v0.1.19.

### HTTP API server

OpenAPI-documented REST API with 30+ endpoints. Start with `smolvm serve start`.

- **Sandbox CRUD** — create, start, stop, delete, list, clone, diff, merge
- **Exec** — REST exec, WebSocket streaming, interactive terminal (bidirectional stdin/stdout/stderr)
- **File CRUD** — read, write, delete, list, multipart upload, tar archive download
- **Snapshots** — push/pull VM state, streaming upload/download for remote transfer
- **Jobs** — async work queue with priority, retry, dead letter
- **MCP** — tool discovery + tool calling via shell-based MCP servers (filesystem, exec, git — 18 tools)
- **Permissions** — RBAC (owner/operator/read-only) with grant/revoke API
- **Secrets** — secure configuration with rotation support
- **Metrics** — Prometheus endpoint
- **Provider** — backend info + health
- **OpenAPI/Swagger UI** — auto-generated docs at `/swagger-ui`

### CLI (smolctl)

Full-featured CLI wrapping the API. Written in TypeScript (Deno).

```bash
# sandbox lifecycle
smolctl up my-sandbox --network --starter node-deno
smolctl sh my-sandbox                    # interactive shell
smolctl exec my-sandbox -- node -e "console.log('hi')"
smolctl down my-sandbox

# file operations
smolctl files ls my-sandbox /workspace
smolctl cp ./local-file my-sandbox:/workspace/
smolctl sync push ./src my-sandbox --exclude node_modules

# git-based workspace merging
smolctl fleet fanout base-vm 4           # clone 4 copies, each on own branch
smolctl fleet exec "vm-*" -- make test   # run tests in all
smolctl fleet gather "vm-*" --into base  # three-way merge all forks back

# portable snapshots
smolctl snapshot push my-sandbox --desc "checkpoint"
smolctl snapshot pull my-snapshot new-sandbox
smolctl snapshot merge my-snapshot target-sandbox
smolctl snapshot upload my-snapshot       # push to remote server
smolctl snapshot download my-snapshot     # pull from remote server

# workspace export (lightweight, ~14KB vs ~100MB)
smolctl snapshot export-workspace my-sandbox ./workspace.tar.gz
smolctl snapshot import-workspace ./workspace.tar.gz target-sandbox
smolctl snapshot to-docker my-sandbox     # generate Dockerfile

# MCP servers
smolctl up my-sandbox --with-mcp         # auto-install MCP servers
smolctl mcp tools my-sandbox             # discover 18 tools
smolctl mcp call my-sandbox filesystem read_file '{"path":"/etc/hostname"}'

# agent workflows
smolctl agent run my-sandbox "build a REST API"
smolctl agent worker my-sandbox --reuse --max-jobs 10

# multi-provider
smolctl provider add cloud https://my-vps:8080 --token secret
smolctl --provider cloud snapshot ls
```

### secret proxy

Host-side API key injection via vsock. Real keys never enter the VM.

- Guest hits `127.0.0.1:9800/anthropic` → vsock → host proxy injects real API key → forwards to Anthropic
- Supports: Anthropic, OpenAI, Google + custom services via TOML config
- Env var stripping: real keys removed from sandbox environment
- Rotation without restart via `PUT /api/v1/secrets`

### portable snapshots

Self-contained `.smolvm` archives that move between machines.

- **Push/pull** — snapshot VM state with git metadata, SHA-256 integrity
- **Lineage tracking** — parent→child chains across snapshots
- **Merge** — three-way git merge between snapshots and running VMs
- **Remote transfer** — streaming upload/download between smolvm servers
- **Workspace export** — lightweight tar.gz of just `/storage/workspace` (~14KB vs ~100MB)
- **Docker interop** — `to-docker` generates Dockerfile with detected packages

### web dashboard

Browser-based dashboard at `web-ui/`. Dark theme, ghostty-web terminal.

- Sandbox list with live status (running/stopped)
- Create, start, stop, delete sandboxes
- Interactive terminal via WebSocket (bidirectional, full TTY)
- ghostty-web (WASM) terminal with WebGL rendering

### provider abstraction

Swap between local and remote smolvm backends.

- `SandboxProvider` trait: local, remote HTTP, future cloud adapters
- `~/.smolvm/providers.json` config
- CLI `--provider` flag routes commands to any backend

### git-based workspace merging

Per-VM isolated storage with git as the merge engine.

- Each VM gets its own ext4 disk at `/dev/vda`, mounted at `/storage/workspace`
- `clone` creates CoW copy with isolated branch
- `fleet fanout` clones N copies for parallel work
- `fleet gather` merges all forks back via three-way merge
- Git bundle transfer between VMs (no shared filesystem needed)

### starter templates

Pre-configured sandbox profiles with init commands.

- 4 built-in starters: `claude-code`, `node-deno`, `python-ml`, `universal`
- `smolctl starter init/build/validate/export/import` for custom starters
- Init commands run on create (install runtimes, clone repos, etc.)

### auth & security

- PKCE OAuth flow (`smolctl auth login`)
- Bearer token API auth with constant-time comparison
- Sandbox RBAC (owner/operator/read-only)
- DNS-based egress filtering
- Fork bomb protection (RLIMIT_NPROC)
- Code signing (HMAC-SHA256) for artifact verification
- Audit trail for secret access

### observability

- Prometheus metrics (`/metrics`)
- Structured JSON logging (`--json-log`)
- Request correlation (`X-Request-Id`)
- Event log (`~/.smolvm/events.ndjson`)
- Session recording + replay

### playtest suite

71 automated tests across 19 scenarios. Run with:

```bash
SMOLCTL="deno run -A cli/smolctl.ts" bash playtests/e2e-playtest.sh
```

### SDKs

- **TypeScript** (`sdk-ts/`) — full API coverage
- **Python** (`sdk-py/`) — full API coverage

### build from source

```bash
# build (macOS)
LIBKRUN_BUNDLE=~/.smolvm/lib cargo build --release
codesign --force --sign - --entitlements smolvm.entitlements target/release/smolvm

# run
DYLD_LIBRARY_PATH=~/.smolvm/lib:/opt/homebrew/lib target/release/smolvm serve start
```

License
-------

Apache-2.0
