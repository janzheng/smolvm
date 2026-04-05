# smolvm

Micro VM platform for agent isolation. Each sandbox is an Alpine Linux VM with its own filesystem, network, and tools.

## Active Code

| Directory | What | Language |
|-----------|------|----------|
| `src/` | smolvm server (Rust, forked from smol-machines/smolvm) | Rust |
| `crates/` | Agent binary, protocol, pack, napi crates | Rust |
| `sdk-ts/` | TypeScript SDK (used by Brigade + smolctl) | TypeScript |
| `cli/smolctl.ts` | CLI wrapper over HTTP API | TypeScript |
| `tests/` | SDK test suites (TS) + shell integration tests (sh) | TypeScript, Bash |
| `playtests/` | E2E playtest scripts | Bash |
| `starters/` | Smolfile templates (node, python, openclaw) | TOML |
| `docs/` | All project documentation | Markdown |
| `mcp-servers/` | MCP server configs for sandboxed tools | TypeScript |
| `deploy/` | Deployment configs (systemd, etc.) | -- |
| `lib/` | Bundled libkrun/libkrunfw dylibs | Binary |

## Legacy (do not modify)

`.references/` -- contains smolvm-experimental, smolvm-manager, web-ui, smolvm-web, smolvm-repo, sdk-py. All superseded. Gitignored, local-only reference.

## Upstream Tracking

Fork of `smol-machines/smolvm`. Upstream remote configured as `upstream`.
Repo root matches upstream's file layout (`src/`, `crates/`, `Cargo.toml` at root) so `git merge upstream/main` works directly.

Our additions on top of upstream: snapshot system, file CRUD API, MCP handlers, jobs queue, auth, starters registry, TypeScript SDK, CLI, test suite.

## Building

Use `cargo make` at repo root -- handles DYLD_LIBRARY_PATH, SMOLVM_AGENT_ROOTFS, and codesigning:

```bash
cargo make dev                    # build + codesign
cargo make smolvm serve start     # run with correct env vars
```

Do NOT use `cargo run` -- it doesn't set the library path.

## Key Env Vars

| Var | Default | Purpose |
|-----|---------|---------|
| `SMOLVM_URL` | `http://127.0.0.1:9090` | Server URL |
| `SMOLVM_API_TOKEN` | *(none)* | Bearer auth token |
| `DYLD_LIBRARY_PATH` | `./lib` | Required for macOS dylib loading |

## Testing

```bash
# Rust unit tests (no server needed)
cargo test

# Shell integration tests (no server needed, needs Hypervisor.framework)
./tests/run_all.sh

# E2E playtests (need running server)
bash playtests/e2e-playtest.sh

# TypeScript SDK tests (need running server)
deno task test-all
```

## API

All routes under `/api/v1/`. See `docs/` for full reference.

Key endpoints:
- `POST /api/v1/sandboxes` -- create sandbox
- `POST /api/v1/sandboxes/:name/exec` -- execute command
- `GET /api/v1/sandboxes/:name/files/*path` -- read file
- `PUT /api/v1/sandboxes/:name/files/*path` -- write file
- `POST /api/v1/sandboxes/:name/snapshots` -- push snapshot

## Known Issues

- Port mapping connections refused (use tunnels instead)
- Container-in-sandbox 500 error (upstream)
- VM can reach host API via TSI (mitigated by auth token)
- libkrun linkage: building server binary on macOS requires correct DYLD_LIBRARY_PATH pointing to bundled libkrun, not homebrew's version
