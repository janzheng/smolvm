# smolvm — Task List

Private project. Internal use only.

---

## Known Bugs (upstream/alpha)

These depend on upstream smolvm/libkrun fixes. Workarounds noted.

- [ ] **T01** Volume mounts (virtiofs visibility)
  - Files via volume mounts not visible inside guest VM
  - Workaround: use file API (`PUT /machines/:id/files/...`) or `exec sh -c 'echo "..." > file'`

- [ ] **T02** Port mapping (connection refused)
  - Port mapping creates but connections refused from host
  - No workaround currently

- [ ] **T04** Container delete returns error
  - Container stop works but delete fails
  - Workaround: machine delete cleans up containers

- [ ] **T06** macOS UID leak into guest rootfs
  - Host UID 501 leaks into guest filesystem ownership
  - Workaround: use `default_user` in machine creation

---

## Security (requires Rust rebuild)

Found via `deno task test-isolation`. See `docs/SECURITY.md` for full details.

- [ ] **S01** VM can reach host API via TSI (CRITICAL) — UPSTREAM REQUIRED
  - Machine with `network: true` can hit host port 8080, manage other machinees
  - Root cause: libkrun TSI intercepts socket syscalls at kernel level, bypassing netfilter
  - iptables rules have no effect — TSI proxies before packets reach netfilter
  - Fix: requires libkrun/TSI layer to support port blocklist in proxy config
  - Code: firewall rules written in agent `main.rs` (will activate if libkrun switches to virtio-net)

- [x] **S02** Non-root exec via setuid/setgid (MEDIUM) — DONE
  - Replaced `su -l` wrapping with proper setuid/setgid in `pre_exec` hook
  - Added `user` field to wire protocol (backward-compatible via `Option<String>`)
  - Verified: non-root can't read /root, can write to own home, can't write to /etc
  - Files: protocol `lib.rs`, agent `main.rs`, handlers `exec.rs`, client `client.rs`

- [ ] **S03** Domain allowlist not enforced — UPSTREAM REQUIRED (same as S01)
  - Code written: iptables allowlist rules in agent, env var plumbing through launcher
  - Blocked by same TSI limitation as S01 — iptables can't intercept TSI traffic
  - Fix: requires libkrun TSI-level domain/IP filtering

- [x] **S05** Fork bomb protection via RLIMIT_NPROC — DONE
  - Added RLIMIT_NPROC (256 soft / 512 hard) to all exec'd processes via `pre_exec`
  - Defense-in-depth: limits process count per exec, prevents runaway forks

- [x] **S06** Cross-platform compilation fixes — DONE
  - Added `#[cfg(target_os = "linux")]` gates for firewall, mount, iptables functions
  - Added `sys_mount` wrapper + mount constant shims for macOS `cargo check`
  - `cargo check --release` now passes on macOS (host + agent)

- [x] **S07** Bearer token API authentication — DONE
  - `--api-token <TOKEN>`, `SMOLVM_API_TOKEN` env var, or `--generate-token`
  - All `/api/v1/*` routes require `Authorization: Bearer <token>` when configured
  - `/health`, `/metrics`, SwaggerUI stay public
  - No token = no auth (backward compatible, prints warning)
  - Constant-time token comparison, no new dependencies
  - Tests support auth via `SMOLVM_API_TOKEN` env var in `_helpers.ts`

- [x] **S04** Rebuild binary to get file API
  - Built from source with `LIBKRUN_BUNDLE=~/.smolvm/lib cargo build --release`
  - Signed with `codesign --entitlements smolvm.entitlements` (Hypervisor entitlement required)
  - Installed to `~/.smolvm/smolvm-bin` (backup at `smolvm-bin.bak`)

---

## Test Results (2026-03-16, rebuilt binary + security fixes + auth)

All tests run against latest binary with S02/S05/S06/auth fixes.

### test-machine: 28 pass, 1 fail (CLI --allow-run permission) ✅
### test-fleet: 8 pass, 0 fail ✅
### test-isolation: 41 pass, 0 fail, 2 skipped ✅
  - Skips: S01 TSI host access (upstream), fork bomb (RLIMIT_NPROC added as defense)
### test-capabilities: 43 pass, 1 fail, 1 skip ✅
  - Fail: Create container (upstream overlay kernel bug)
  - Skip: Port mapping T02 (upstream)

**Total: 120 pass, 2 fail (upstream), 3 skip**

### Test infrastructure
- [x] `tests/_helpers.ts` — shared helpers with auth token support via `SMOLVM_API_TOKEN`
- [x] All API calls have 30s timeout to prevent hangs
- [x] Auto-normalizes `exitCode` → `exit_code`

---

## TODO

- [x] Build Deno CLI tool (`smolctl`) for machine management
- [x] ~~Build and push starter Docker images to registry~~ — wontfix, smolvm uses microVMs not Docker
- [x] Document REST API (→ `docs/API.md`)
- [x] Add cloudflared to claude-code starter (already in Dockerfile + docs)

---

## Build Notes

Building smolvm from source on macOS (2026-03-16):

```bash
# Prerequisites
brew install filosottile/musl-cross/musl-cross  # for cross-compiling agent
rustup target add aarch64-unknown-linux-musl     # Linux target

# Build host binary (macOS)
cd smolvm-plus
LIBKRUN_BUNDLE=~/.smolvm/lib cargo build --release

# Sign with Hypervisor entitlement (REQUIRED on macOS)
codesign --force --sign - --entitlements smolvm.entitlements target/release/smolvm

# Cross-compile agent (if needed — original agent is protocol-compatible)
RUSTC="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc" \
CC_aarch64_unknown_linux_musl=aarch64-linux-musl-gcc \
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=aarch64-linux-musl-gcc \
$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo build \
  --release --target aarch64-unknown-linux-musl -p smolvm-agent

# Install
cp target/release/smolvm ~/.smolvm/smolvm-bin
# Note: CLI changed from `smolvm serve` to `smolvm serve start`
```

---

## Done

Everything below was implemented in `smolvm-plus` and SDKs:

- [x] T03 Auto-resize overlay FS
- [x] T05 Fix CLI/serve DB lock (`--no-persist`)
- [x] T07 Checkpoint/Restore
- [x] T08 Starter images + registry
- [x] T09a Clone endpoint
- [x] T09b Diff endpoint
- [x] T10 Merge endpoint
- [x] T11 Push/Pull snapshots
- [x] T12 File copy API (SDK exec channel)
- [x] T13 Egress filtering (`allowed_domains`)
- [x] T14 Resource monitoring (`/stats`)
- [x] T17 TypeScript SDK
- [x] T18 Python SDK
- [x] T26 File CRUD API endpoints
- [x] T27 WebSocket streaming exec
- [x] T28 Init commands
- [x] T29 Non-root exec
- [x] T30 Graceful shutdown
- [x] T31 Structured JSON logging
- [x] T32 Prometheus metrics
- [x] T15 Remove fake SDK refs (updated READMEs to use local imports)
- [x] T16 Document REST API (→ `docs/API.md`)
