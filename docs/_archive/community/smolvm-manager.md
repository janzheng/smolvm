# smolvm Manager — Community Web UI

**Repo:** [nexex18/smolvm_manager](https://github.com/nexex18/smolvm_manager)
**License:** Apache-2.0
**Stack:** Python (FastHTML + MonsterUI + HTMX), SQLite, shell scripts
**Created:** 2026-02-11

A web UI for creating, provisioning, and managing smolvm microVMs on macOS.
The core use case is running Claude Code agents in isolated VMs with network
safety guardrails. This is the most complete "agent dev environment on
smolvm" implementation we've found.

**TL;DR — What we learned from this project:**
1. MicroVM > Machine — they independently hit the same overlayfs bug
2. SSH is the real control plane — `smolvm exec` for bootstrapping, SSH for everything else
3. Egress filtering is solvable today — 3-layer approach (Node guard + LD_PRELOAD + HTTP proxy)
4. Claude Code works in smolvm — with a TCP backlog monkey-patch (`listen()` backlog → 1)
5. The bootstrap tax is real — 10-12 min provisioning, no snapshot shortcut

---

## What It Does

1. **Create VMs** — Web form: name, username, RAM, allowed domains. Provisioning
   runs in background with live progress bar.
2. **Import existing VMs** — Register a smolvm microVM you already created.
3. **Lifecycle management** — Start/Stop/Delete with one click.
4. **Health checks** — 12 SSH-based checks with auto-fix buttons.
5. **Domain allowlist** — Edit per-VM allowed domains in the UI. Proxy reloads
   live.
6. **Two VM types** — Standard (Claude Code + tools) and Lobster (+ OpenClaw
   AI gateway).

## Architecture

```
Browser → FastHTML (localhost:5002) → SQLite (smolvm.db)
                                   → smolvm CLI (microvm create/start/stop/exec)
                                   → SSH (health checks, fixes)
```

No REST API orchestration — they use `smolvm microvm` CLI commands via
subprocess, then SSH into the VM for health checks and management. This
sidesteps the REST API entirely (which we tested in CX04).

The key insight: **SSH is the control plane.** Once the VM has sshd running,
all management goes through SSH rather than `smolvm exec`. This avoids the
serial-exec limitation we hit in testing.

## How They Load Claude Code

The `setup-vm-v2.sh` provisioning script (648 lines) does everything:

```bash
# 1. Create microVM (not machine — they found the overlayfs bug too)
smolvm microvm create $VM_NAME --net -p 2222:22 --cpus 2 --mem 4096

# 2. Install packages (7+ second bootstrap tax, same as our findings)
smolvm microvm exec --name $VM_NAME -- apk add openssh-server nodejs npm bash curl git
smolvm microvm exec --name $VM_NAME -- apk add chromium python3 py3-pip gcc sqlite

# 3. Configure SSH (the control plane)
smolvm microvm exec --name $VM_NAME -- ssh-keygen -A
smolvm microvm exec --name $VM_NAME -- /usr/sbin/sshd

# 4. Install Claude Code
smolvm microvm exec --name $VM_NAME -- npm install -g @anthropic-ai/claude-code
smolvm microvm exec --name $VM_NAME -- claude install  # native binary

# 5. Install compound-engineering plugin (optional, for Lobster VMs)
su - $VM_USER -c 'claude plugin marketplace add https://github.com/EveryInc/compound-engineering-plugin.git'
su - $VM_USER -c 'claude plugin install compound-engineering@every-marketplace'
```

They also write a `CLAUDE.md` into the VM with network enforcement rules,
so Claude Code knows about the domain allowlist and won't try to bypass it.

## The Domain Allowlist Proxy (Network Safety)

This is the most interesting part — they solved smolvm's "all-or-nothing
networking" problem (item #10 in our COMPARISON.md "What smolvm Is Missing").

**Three enforcement layers:**

1. **Node.js net guard** (`netguard.js` via `NODE_OPTIONS=--require`) — blocks
   all non-localhost TCP connections at the socket level. Prevents Node.js
   programs from connecting directly.

2. **LD_PRELOAD guard** (`netguard.so`) — blocks direct TCP connections from
   any binary (C, Python, etc.) via a shared library that intercepts `connect()`.

3. **HTTP proxy** (`proxy-allowlist.js` on `127.0.0.1:8888`) — domain allowlist
   for HTTP/HTTPS traffic. All outbound requests go through this proxy via
   `HTTP_PROXY`/`HTTPS_PROXY` env vars. Returns 403 for non-whitelisted domains.

Claude Code's own infrastructure (api.anthropic.com, etc.) bypasses the proxy
via `NO_PROXY` and connects directly — the proxy is for restricting *agent
tool calls*, not Claude itself.

**Limitation:** A sufficiently clever agent could unset the proxy env vars.
This is a safety net, not a hard machine. But combined with the Node.js guard
and LD_PRELOAD guard, it's surprisingly robust.

## Health Check System

12 SSH-based checks, each with an auto-fix button:

| Check | What It Verifies |
|---|---|
| SSH (root) | Root SSH access works |
| SSH (user) | Non-root user SSH access works |
| Claude Code | `claude --version` runs |
| Node.js | `node --version` runs |
| npm | `npm --version` runs |
| Python 3 | `python3 --version` runs |
| SQLite 3 | `sqlite3 --version` runs |
| git | `git --version` runs |
| Proxy running | Proxy responds on port 8888 |
| Proxy filtering | Blocked domain returns 403 |
| Node.js net guard | Direct TCP connection blocked |
| Playwright + Chromium | Headless browser launches |

Failed checks show a "Fix" button that runs an idempotent repair command as
root, then re-verifies. Example: if Claude Code check fails, the fix runs
`npm install -g @anthropic-ai/claude-code@latest`.

## Notable Patterns & Solutions

### libkrun TCP Backlog Fix

Node.js defaults to TCP listen backlog of 511. libkrun's TSI (Transparent
Socket Impersonation) rejects this with `EINVAL`. Claude Code's OAuth
callback server fails without this fix.

**Solution:** A monkey-patch (`/usr/local/lib/fix-listen.js`) loaded via
`NODE_OPTIONS=--require` that forces `backlog: 1` on all `listen()` calls.

We didn't hit this in CX04 testing because we used the REST API for exec
rather than running Node.js servers inside the VM. But it would bite anyone
trying to run Claude Code interactively via SSH.

### Playwright on Alpine

Playwright's bundled browser binaries are glibc-compiled. Alpine uses musl.
**Solution:** Install Alpine's native `chromium` package + a wheel rename
trick for the Python Playwright package. The bundled `node` binary in
Playwright's driver directory is replaced with a symlink to system Node.js.

### SSH as Control Plane

They bypass `smolvm exec` for management after initial provisioning. Once
sshd is running, all commands go through SSH. This avoids the serial-exec
limitation (our finding #8 in COMPARISON.md) and gives them proper shell
sessions.

**Caveat:** sshd doesn't auto-start (no init system in smolvm). The `devbox`
helper script and the web UI's Start button both handle starting sshd after
boot.

### Host UID Leak

macOS UID 501 leaks into the guest rootfs, making `/var/empty` and `/root`
owned by the wrong user. sshd refuses to start until ownership is fixed.
Every boot requires: `chown root:root /var/empty /root; chmod 755 /var/empty`.

We didn't discover this in CX04 because we never set up SSH.

### MicroVM, Not Machine

They explicitly chose microVM mode over machine mode because:
> "machines have a known overlayfs bug that prevents filesystem writes
> (like `apk add` or `npm install`)"

This matches our finding that volume mounts are buggy. MicroVMs write
directly to the Alpine rootfs, so package installation works.

## VM Types

### Standard

General-purpose: SSH, Claude Code, Node.js, Python, Playwright + Chromium,
domain allowlist proxy, network guards. Provisioned by `setup-vm-v2.sh`
(~10 min).

### Lobster

Everything in Standard + a running OpenClaw AI gateway. Gets a dedicated
OpenClaw port, auth token, and machine mode toggle in the UI. Provisioned by
`setup-vm-lobster.sh` (~12 min). Requires Node.js v22+ (upgraded from
Alpine 3.21 repos since the base 3.19 only has v21).

## Test Suite

151 tests across 4 files:

| File | Tests | What |
|---|---|---|
| `test_db.py` | 34 | SQLite database layer |
| `test_checks.py` | 23 | Health check runner (mocked SSH) |
| `test_e2e.py` | 55 | Playwright browser tests |
| `test_setup_script.py` | 39 | Setup script validation |

## What They Solved That We Didn't Test

| Problem | Their Solution | Our Status |
|---|---|---|
| Egress filtering | 3-layer proxy + guards | Identified as missing (#10) |
| SSH into VMs | Port forwarding + sshd setup | Never tested |
| Claude Code in VM | npm install + libkrun fix | Never tested (REST API only) |
| Non-root users | adduser + SSH + venv | Never tested |
| Playwright/Chromium | System chromium + wheel trick | Never tested |
| Web UI management | FastHTML + SQLite | We used scripts |
| Health monitoring | 12 checks + auto-fix | We did manual verification |

## Project Structure

```
smolvm_manager/
├── UI/
│   ├── app.py              — FastHTML web app
│   ├── db.py               — SQLite (vms + vm_checks tables)
│   ├── checks.py           — 12 health checks + fix commands
│   ├── test_*.py           — 151 tests
│   └── smolvm-lifecycle.md — Internal docs
├── setup-vm-v2.sh          — Standard VM provisioning (648 lines)
├── setup-vm-lobster.sh     — Lobster VM provisioning (+ OpenClaw)
├── devbox                  — Helper: start/stop/ssh/exec/status
├── crates/                 — Rust crates (smolvm-agent, smolvm-pack, smolvm-protocol)
├── scripts/                — Build scripts, smoke tests
├── docs/                   — Internal guides, brainstorms, solutions
└── src/                    — Rust source (smolvm fork?)
```

The repo also contains Rust crates (`smolvm-agent`, `smolvm-pack`,
`smolvm-protocol`) and a full Rust source tree — it may be a fork of smolvm
itself with additional agent management capabilities built on top.

## Relevance to Our Work

This project validates several of our CX04 findings and extends them:

1. **MicroVM > Machine** — they independently reached the same conclusion
   about the overlayfs bug forcing microVM mode.

2. **SSH as escape hatch** — `smolvm exec` is fine for bootstrapping, but SSH
   is the real control plane for interactive agent work.

3. **Egress filtering is solvable** — their 3-layer approach (Node guard +
   LD_PRELOAD + proxy) works today without changes to smolvm itself.

4. **The bootstrap tax is real** — their provisioning scripts take 10-12
   minutes (vs our 7s for basics). They don't have a snapshot solution either.

5. **Claude Code works in smolvm** — with the TCP backlog fix, Claude Code
   runs fine via SSH. This is a stronger validation than our REST API-only
   testing.
