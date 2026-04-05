# smolvm Roadmap: From Local Sandbox to Git-for-VMs

A strategic analysis of what it takes to bring smolvm from a fast local sandbox
to a full-featured VM platform with parity (and beyond) vs Fly Sprites and Deno
Sandbox. Based on hands-on testing of all four platforms (CX01–CX04, Feb 2026).

---

## Part 1: What Sprites and Deno Sandbox Were Designed For

### 1.1 Fly Sprites — Production Agent Orchestration

**Philosophy:** Zero-friction AI agent execution. The agent should just work —
no setup, no installs, no config.

**Target users:** Agent orchestration platforms, AI companies running N agent
tasks in parallel.

**Key design decisions:**

| Decision | Why |
|---|---|
| Pre-install everything (Claude Code 2.1.47, Codex, Gemini CLI, Node 22, Python 3.13, Deno 2.6, Go 1.25, Git 2.48) | Zero bootstrap tax — 0s setup vs 7-30s on other platforms |
| Checkpoints as first-class primitive (400ms create, 14s restore) | Fault tolerance for long agent runs — save before risky operations, rollback on failure |
| Real Firecracker microVMs (100GB disk, root access) | Full Linux, not a container — can run anything |
| Fleet management (3+ sprites parallel, 159ms/sprite) | Horizontal scale for parallel agent workloads |
| Scale-to-zero (30s idle, wake on demand) | Cost efficiency — pay only for active compute |
| Per-second billing | Predictable costs for burst workloads |

**What it optimizes for:** Total lifecycle time. The fastest path from "I have
a task" to "I have results." CREATE 0.5s → BOOTSTRAP 0s → WORK → EXTRACT →
DESTROY 0.6s = **6.2s total**.

**What it trades away:** Local execution (cloud-only), secret security (real
env vars visible in shell), open-source (proprietary platform).

---

### 1.2 Deno Sandbox — Secure Distributed Compute

**Philosophy:** Security-first distributed compute. Secrets should never be
extractable, even by malicious code inside the sandbox.

**Target users:** Multi-tenant platforms hosting untrusted code,
security-sensitive workloads, Deno-native applications.

**Key design decisions:**

| Decision | Why |
|---|---|
| Secret placeholder model (keys show as `DENO_SECRET_PLACEHOLDER_xxx`, real values only during approved outbound HTTP) | Keys are physically impossible to exfiltrate — novel security model |
| Firecracker microVMs (not V8 isolates) | Real Linux, real process isolation — stronger than containers |
| Volume snapshots (~13s create, ~2.5s boot) | State persistence without exposing the underlying disk |
| `exposeHttp()` for instant public URLs | Inbound HTTP just works — one function call |
| Clean JSR SDK (`@deno/sandbox`) | Idiomatic Deno API — `deno add`, write a script, done |
| Pre-installed Deno + Node compat + Python | Because it's Deno's own product — they control the base image |

**What it optimizes for:** Security posture. API keys cannot be exfiltrated
even by malicious code. The strongest secret model of any platform tested.

**What it trades away:** Git clone (HTTPS proxy breaks git auth),
cross-sandbox parallelism (SDK stream ID errors), instance limits (5 per org
in pre-release), standalone Node.js (Deno compat layer only).

---

### 1.3 What They Share (and What Differentiates Them)

**Shared foundations:**
- Both use Firecracker microVMs (hardware-level isolation)
- Both have state persistence (checkpoints/snapshots)
- Both support programmatic orchestration via SDKs
- Both are cloud-hosted with no local option
- Both have reasonable documentation (3/5)

**The key split:**
- **Sprites optimizes for speed and convenience** — everything pre-installed,
  fastest lifecycle, checkpoints for fault tolerance
- **Deno optimizes for security** — secret placeholders, egress control,
  keys never visible inside the VM

**smolvm's opportunity:** Be the local-first layer that complements both.
Develop and test locally on smolvm (free, fast), deploy to Sprites for
production speed or Deno for production security.

---

## Part 2: Where smolvm Falls Short Today

### 2.1 Gaps vs Fly Sprites

| Capability | Sprites | smolvm | Severity |
|---|---|---|---|
| **Checkpoint/Restore** | 400ms create, 14s restore | Nothing | CRITICAL |
| **Pre-installed agents** | Claude Code, Codex, Gemini, Pi-Mono | Bare Alpine — must install everything | HIGH |
| **File copy API** | REST `PUT /fs/write`, `GET /fs/read` | Must pipe through `exec cat` | MEDIUM |
| **Within-VM parallelism** | Parallel exec within sprite | Serial (3s for 3x1s sleep) | MEDIUM |
| **Inbound HTTP** | Port 8080 public | Port mapping broken | MEDIUM |
| **SDK** | `@fly/sprites` npm package | REST-only (claimed SDKs 404) | MEDIUM |
| **Documentation** | 3/5 | 1/5 | HIGH |
| **Fleet management** | 159ms/sprite, health API | 82ms/sandbox (faster!), no health API | LOW |

### 2.2 Gaps vs Deno Sandbox

| Capability | Deno | smolvm | Severity |
|---|---|---|---|
| **Secret placeholder model** | Keys never visible inside VM | Real env vars (extractable) | HIGH (for multi-tenant) |
| **Volume snapshots** | Create, snapshot, boot from snapshot | Nothing | CRITICAL |
| **Inbound HTTP** | `exposeHttp()` instant public URL | Port mapping broken | MEDIUM |
| **Within-VM parallelism** | Parallel `sh` calls | Serial exec | MEDIUM |
| **SDK** | Clean JSR package | REST-only | MEDIUM |
| **Egress filtering** | Transparent proxy with host allowlists | All-or-nothing `--net` | LOW |

### 2.3 Bugs That Need Fixing First

These are alpha issues that block existing features from working:

| Bug | Impact | Workaround |
|---|---|---|
| **Volume mounts invisible** | Files not visible across host/guest boundary | Write via `exec sh -c 'echo "..." > file'` |
| **Port mapping broken** | Connection refused from host | None (can't expose services) |
| **Overlay FS not auto-resized** | `overlay_gb: 4` creates 4GB disk but 487MB filesystem | Manual `resize2fs /dev/vdb` after boot |
| **Container-in-sandbox 500** | crun storage path error on container start | Use OCI image `run` endpoint instead |
| **CLI/serve DB lock** | `smolvm microvm ls` fails when `smolvm serve` runs | Use REST API exclusively when serving |
| **macOS UID leak** | Host UID 501 leaks into guest rootfs | Create non-root user explicitly |

### 2.4 Documentation Debt

| Issue | Impact |
|---|---|
| Website claims npm/pip SDKs exist — both 404 | Confuses every new user |
| REST API (the best feature) completely undocumented | Users don't know it exists |
| API doc pages are empty shells | Misleading — looks like content should be there |
| OpenAPI spec and Swagger UI not linked from docs | Discoverable only by accident |
| Env var support not documented | Users think env vars don't work |
| `overlay_gb` / `storage_gb` behavior undocumented | Users hit the 487MB wall |

---

## Part 3: Can smolvm Serve Those Same Use Cases?

### 3.1 Agent Orchestration (Sprites' Territory)

**Verdict: YES, with investment.**

What works today:
- Fleet management via REST API (create N VMs, parallel exec across VMs)
- All 4 coding agents verified working (Claude Code, Pi-Mono, Codex, Gemini CLI)
- OCI images can eliminate bootstrap tax
- Files persist across stop/start
- Fastest raw boot of any platform (300ms)

What's missing:
- Checkpoint/restore (the killer feature for long agent runs)
- Pre-built starter images (must build your own or bootstrap every time)
- File copy API (have to pipe through exec)
- Inbound HTTP (can't expose agent's work-in-progress)

**The gap is narrower than it appears.** Most missing features are implementable.
smolvm already has the hardest part (fast, reliable VM orchestration). The
missing pieces are mostly API surface and persistence primitives.

### 3.2 Secure Multi-Tenant Compute (Deno's Territory)

**Verdict: YES — but it's a layer above smolvm, not smolvm itself.**

smolvm doesn't need to implement Deno's secret placeholder model or egress
proxy. Those are orchestration-layer concerns. A multi-tenant system would:

1. Run an orchestrator that manages N smolvm instances (one per tenant)
2. The orchestrator handles auth, billing, routing, secret injection
3. Each tenant gets hardware-isolated VMs (libkrun already provides this)
4. Egress filtering lives in the orchestrator (domain allowlists per tenant)
5. Secrets injected per-exec via the existing `env` API — never stored in VM

smolvm already has the hard part: **hardware-level VM isolation**. A
multi-tenant orchestrator on top is a straightforward web service that calls
the smolvm REST API. The smolvm-manager community project is a proof of
concept for exactly this pattern (per-VM egress filtering, health checks,
web UI).

What smolvm itself should add to support this:
- Egress filtering at VMM level (feature branch already exists)
- Resource monitoring endpoint (CPU/memory/disk per VM)
- The rest (auth, billing, tenant isolation) belongs in the orchestrator

### 3.3 Summary

| Use Case | Feasible? | Investment | Notes |
|---|---|---|---|
| Local agent dev/test | **YES, today** | Already works | Best-in-class boot + free |
| Production agent fleet | **YES, with work** | 3-6 months | Needs checkpoints, starters, file API |
| CI/CD sandboxes | **YES, with work** | 2-3 months | Needs port mapping fix, file I/O |
| Multi-tenant hosting | **YES** | Orchestration layer on top | smolvm provides VM isolation; orchestrator handles auth/billing/secrets |
| Edge compute | **NO** | Separate product | Needs cloud hosting |
| General-purpose local VMs | **YES, today** | Minor polish | Already the best local VM tool |

---

## Part 4: The Parity Roadmap

### Task List — What Needs to Happen (and in What Order)

The critical insight: **checkpoint/restore gates almost everything.** It's the
`git init` of the entire git-for-VMs vision. Without it, no starters, no
clone/merge, no push/pull, no fault tolerance for long agent runs.

#### Critical Path (sequential — each depends on the previous)

- [ ] **T01** Fix volume mounts (virtiofs visibility) — _alpha bug, smolvm core_
- [ ] **T02** Fix port mapping (connection refused) — _alpha bug, smolvm core_
- [x] **T03** Auto-resize overlay FS on creation — _PR ready: `resize_ext4_filesystem()` in storage.rs_
- [ ] **T04** Fix container-in-sandbox 500 (crun storage path) — _alpha bug_
- [x] **T05** Fix CLI/serve DB lock coexistence — _PR ready: `--no-persist` flag in serve.rs_
- [ ] **T06** Fix macOS UID leak into guest rootfs — _alpha bug_
- [x] **T07** **Checkpoint/Restore** — _PR ready: `checkpoints.rs` handler_
  - Cold checkpoint: stop VM, snapshot overlay disk + metadata
  - API: `POST /sandboxes/{name}/checkpoint`, `GET /checkpoints`, `POST /checkpoints/{id}/restore`, `DELETE /checkpoints/{id}`
  - SDK support in both TypeScript and Python SDKs
  - Rust implementation: ~460 lines, `src/api/handlers/checkpoints.rs`
- [ ] **T08** Starter images — _depends on T07 (starters ARE checkpoints)_
  - `smolvm/claude-code`, `smolvm/all-agents`, `smolvm/python-ml`, etc.
  - Publish to Docker Hub / GitHub Container Registry
  - CLI: `smolvm create my-vm --from claude-code`
- [ ] **T09** Clone/Diff — _depends on T07_
  - `smolvm clone my-vm --name fork-a` (copy overlay + metadata)
  - `smolvm diff fork-a fork-b` (compare overlay filesystems)
- [ ] **T10** Merge — _depends on T09_
  - `smolvm merge fork-a --into my-vm --files` (file-level apply)
  - Conflict resolution: theirs-wins / ours-wins / manual
- [ ] **T11** Push/Pull (local ↔ cloud) — _depends on T07 + cloud infra_
  - `smolvm push my-vm checkpoint-name --to cloud`
  - `smolvm pull cloud-vm latest`
  - Incremental transfer (changed blocks only, like rsync)
  - S3/R2-compatible checkpoint storage

#### Parallel Track A — File & Network (no dependency on checkpoint)

- [x] **T12** File copy API — implemented in SDK via exec channel
  - `sandbox.writeFile()`, `readFile()`, `writeFiles()`, `listFiles()`, `exists()`
  - Uses base64 encode/decode through existing exec channel (no Rust changes needed)
- [ ] **T13** Egress filtering — domain allowlist per VM
  - Feature branch exists (`binbin-vmm-level-network-policy`)
  - API: `allowed_domains: ["api.anthropic.com", "npmjs.org"]`
- [x] **T14** Resource monitoring — `GET /sandboxes/{name}/stats`
  - PR ready: `stats.rs` handler + `ResourceStatsResponse` type
  - Returns: cpus, memory_mb, state, overlay/storage disk sizes

#### Parallel Track B — SDKs & Docs (can start immediately)

- [ ] **T15** Remove fake SDK references from website — _trivial, do today_
- [ ] **T16** Document the REST API — _currently completely hidden_
  - Link OpenAPI spec + Swagger UI from docs
  - Document `overlay_gb`, `storage_gb`, env vars, MicroVM API
- [x] **T17** TypeScript SDK — `@smolvm/sdk` in `sdk-ts/`
  - Matches just-bash/Vercel Sandbox API shape (Part 8)
  - Sandbox, MicroVM, Fleet, File I/O via exec, Stats endpoint
  - `deno check mod.ts` passes clean
- [x] **T18** Python SDK — async httpx wrapper in `sdk-py/`
  - Mirrors TypeScript SDK API surface exactly
  - Sandbox, MicroVM, Fleet, File I/O via exec, Stats, Checkpoints
  - 27/27 integration tests pass against live `smolvm serve`
- [ ] **T19** Add tutorials from `docs-tutorials.md` to official docs

#### Parallel Track C — Cloud Hosting (depends on T07 + T11)

- [ ] **T20** Test nested virtualization — can smolvm run inside Fly Machines?
- [ ] **T21** API gateway + auth — HTTPS + token auth around smolvm serve
- [ ] **T22** Checkpoint storage backend — S3/R2 for push/pull
- [ ] **T23** Billing/metering — per-second usage tracking per user
- [ ] **T24** Web dashboard — VM management UI
  - Integrate just-bash for in-browser preview (Part 8)
  - xterm.js terminal connected to smolvm exec via WebSocket
- [ ] **T25** Starter registry — browse/pull community starters
- [ ] **T26** execd daemon — extend smolvm-agent with OpenSandbox-style API
  - File CRUD, SSE streaming, metrics, code interpreter (Part 7)

#### Dependency Chain

```
Bug fixes (T01–T06)
  └→ Checkpoint/Restore (T07) ← THE CRITICAL PATH
       ├→ Starters (T08)
       ├→ Clone/Diff (T09) → Merge (T10)
       └→ Push/Pull (T11) → Cloud hosting (T20–T25)

File copy API (T12) ──┐
Egress filtering (T13)┤ can start in parallel
Resource monitoring (T14)┘

Docs & SDKs (T15–T19) ← can start TODAY
  └→ just-bash API compat (via T17)

execd daemon (T26) ← independent, high-value
```

#### What Can Be Done Right Now (no smolvm core changes needed)

These don't require any changes to smolvm's Rust codebase:

1. **T15** — Remove fake SDK references (edit website)
2. **T16** — Document the REST API (write docs)
3. **T17** — TypeScript SDK (wrap existing REST API)
4. **T18** — Python SDK (wrap existing REST API)
5. **T19** — Add tutorials to docs
6. Publish OCI starter images to Docker Hub (not as fast as checkpoint-based
   starters, but eliminates bootstrap tax today)

---

### Tier 1 — Bug Fixes (Weeks 1–4)

Fix what's broken. These are alpha bugs, not missing features.

| Fix | Why | Difficulty |
|---|---|---|
| **Volume mounts** — virtiofs visibility | Unblocks natural file I/O (host ↔ guest) | Medium |
| **Port mapping** — connection refused | Unblocks inbound HTTP, exposing services | Medium |
| **Auto-resize overlay FS** on creation | Eliminates manual `resize2fs` step | Easy |
| **Container-in-sandbox** — crun storage path | Unblocks nested container workflows | Medium |
| **CLI/serve DB lock** coexistence | Let CLI and daemon work side by side | Easy |
| **macOS UID leak** into guest rootfs | Predictable non-root user setup | Easy |

### Tier 2 — Feature Parity (Months 2–4)

Match cloud sandboxes on core capabilities.

#### 2a. Checkpoint/Restore (CRITICAL)

The single most important missing feature. Without it, smolvm can't compete
for long-running agent workloads.

**What it does:** Save VM state at a point in time. Restore to that state
later. Like git commit + git checkout, but for the entire VM.

**API design:**

```
POST   /api/v1/sandboxes/{name}/checkpoint            → create checkpoint
GET    /api/v1/sandboxes/{name}/checkpoints            → list checkpoints
POST   /api/v1/sandboxes/{name}/restore/{checkpoint}   → restore
DELETE /api/v1/sandboxes/{name}/checkpoints/{id}       → delete
```

**CLI:**

```bash
smolvm checkpoint create my-vm --name "after-bootstrap"
smolvm checkpoint list my-vm
smolvm checkpoint restore my-vm after-bootstrap
```

**Implementation:** Cold checkpoint (stop VM, snapshot overlay disk +
metadata). Live checkpoint via CRIU would preserve running processes but is
much harder.

**Performance targets:**
- Create: <500ms (overlay disk copy — local I/O, should beat Sprites' 400ms)
- Restore: <1s (copy overlay back + boot — should beat Sprites' 14s since
  it's all local disk)

**Storage:** `~/.smolvm/checkpoints/{vm-name}/{checkpoint-name}/`

#### 2b. File Copy API

Direct file read/write without exec piping.

```
PUT  /api/v1/sandboxes/{name}/files?path=/workspace/file.txt   → write
GET  /api/v1/sandboxes/{name}/files?path=/workspace/file.txt   → read
GET  /api/v1/sandboxes/{name}/files?path=/workspace/&list=true → list dir
```

Implementation via the exec channel (write: `echo $CONTENT | base64 -d > $PATH`,
read: `base64 $PATH`) or via 9p/virtiofs when volume mounts are fixed.

#### 2c. Egress Filtering

Domain-based network allowlists instead of all-or-nothing `--net`.

```json
{
  "name": "my-vm",
  "network": true,
  "allowed_domains": ["api.anthropic.com", "registry.npmjs.org", "github.com"]
}
```

Note: A feature branch already exists (`binbin-vmm-level-network-policy`)
implementing VMM-level network policy enforcement. This is stronger than the
smolvm-manager userspace proxy approach.

#### 2d. Resource Monitoring

```
GET /api/v1/sandboxes/{name}/stats → {cpu_percent, memory_mb, disk_used_mb, uptime_s}
```

### Tier 3 — Developer Experience (Months 3–5)

#### 3a. TypeScript SDK

Publish to npm (fulfill the existing doc promise). Thin wrapper around REST API.

```typescript
import { Smolvm } from "smolvm";

const client = new Smolvm();
const vm = await client.create({ name: "my-vm", cpus: 2, memoryMb: 4096 });
await vm.start();

const result = await vm.exec("echo hello");
console.log(result.stdout); // "hello"

await vm.writeFile("/workspace/main.ts", code);
const content = await vm.readFile("/workspace/main.ts");

const cp = await vm.checkpoint("after-setup");
// ... do risky work ...
await vm.restore(cp);

await vm.stop();
await vm.delete();
```

Auto-generate types from the existing OpenAPI spec.

#### 3b. Python SDK

Same approach, async/await with `httpx`.

```python
from smolvm import Smolvm

async with Smolvm() as client:
    vm = await client.create(name="my-vm", cpus=2, memory_mb=4096)
    await vm.start()
    result = await vm.exec("echo hello")
    print(result.stdout)  # "hello"
```

#### 3c. Documentation Overhaul

- Document the REST API (currently best feature, completely hidden)
- Remove fake SDK references until real SDKs ship
- Add the tutorials from `docs-tutorials.md`
- Link OpenAPI spec and Swagger UI from docs
- Document `overlay_gb`, `storage_gb`, env vars, MicroVM API

#### 3d. Starter Images

Pre-built OCI images for common workloads. Eliminates bootstrap tax.

| Starter | Contents | Size | Bootstrap |
|---|---|---|---|
| `smolvm/claude-code` | Alpine + Node 22 + Claude Code + non-root user + all fixes | ~500MB | 0s |
| `smolvm/all-agents` | Above + Codex + Pi-Mono + Gemini CLI | ~2GB | 0s |
| `smolvm/python-ml` | Alpine + Python 3.13 + pip + numpy/pandas/scipy | ~1GB | 0s |
| `smolvm/node-dev` | Alpine + Node 22 + npm + git + common tools | ~500MB | 0s |
| `smolvm/rust-dev` | Alpine + Rust toolchain + cargo | ~1.5GB | 0s |
| `smolvm/blank` | Bare Alpine (current default) | ~50MB | 7s |

Distribute via Docker Hub or GitHub Container Registry.

```bash
smolvm create my-vm --image smolvm/claude-code
# Ready to run Claude Code immediately — no apk, no npm, no user setup
```

### Tier 4 — Production Readiness (Months 5–8)

| Feature | Why |
|---|---|
| Linux GA | Already nearly done — code exists, tests pass |
| Init system / service management | sshd, servers don't auto-start without it |
| Structured logging | Log forwarding, debug-friendly output |
| Prometheus metrics endpoint | Monitoring and alerting |
| Non-root exec by default | Security hardening |
| Graceful shutdown + crash recovery | No data loss on host reboot |

---

## Part 5: Beyond Parity — The Git-for-VMs Vision

### 5.1 The Core Idea

Git manages code. Docker manages images. **What manages the full execution
environment — files + installed apps + running state + configuration?**

The vision: treat a VM the same way git treats a repository.

| Git | VM Equivalent |
|---|---|
| `git commit` | `smolvm checkpoint` — save state |
| `git branch` | `smolvm clone` — diverge |
| `git merge` | `smolvm merge` — combine results |
| `git push` | `smolvm push` — upload to cloud |
| `git pull` | `smolvm pull` — download from cloud |
| `git clone template` | `smolvm create --from starter` — bootstrap |

This is not just about files. It's **files + execution state + installed
packages + system configuration**, all in one atomic unit.

**Why this matters for AI agents:** An agent session is stateful. It installs
tools, modifies configs, writes code, runs tests. If the agent fails, you
want to roll back. If you want to try two approaches, you want to branch. If
you want to share results, you want to push. No existing tool does all of this.

### 5.2 Snapshots and Checkpoints

The foundation of everything else. Without snapshots, you can't clone, branch,
or push.

**What a checkpoint contains:**
- Overlay disk image (all filesystem changes since boot)
- VM metadata (CPU, memory, env vars, network config)
- Smolfile (declarative config for reproducibility)
- Optionally: process state via CRIU (running processes frozen and restored)

**Storage:** `~/.smolvm/checkpoints/{vm-name}/{checkpoint-name}/`

**Two modes:**
- **Cold checkpoint** (stop VM, snapshot disk) — simple, reliable, portable
- **Live checkpoint** (CRIU process freeze) — preserves running state but
  harder to implement, less portable across architectures

**Performance targets (local disk I/O):**
- Cold checkpoint create: <500ms
- Cold checkpoint restore: <1s (boot from snapshot)
- Should easily beat cloud platforms (Sprites 400ms/14s, Deno ~13s/~2.5s)
  because there's no network round-trip

### 5.3 Starters (Pre-Built Images)

Starters are checkpointed VMs with common toolchains pre-installed. Like
Docker Hub images, but they include the full VM config — not just the
filesystem.

**How it works:**

```bash
# Create a starter
smolvm create base --image alpine:3.19
smolvm exec base -- apk add nodejs npm git bash curl
smolvm exec base -- npm install -g @anthropic-ai/claude-code
smolvm exec base -- adduser -D agent
smolvm checkpoint create base --name claude-ready
smolvm starter save claude-ready --as claude-code

# Use a starter
smolvm create my-agent --from claude-code
# Boots in ~300ms, Claude Code already installed, user already created
```

**Starter registry:**
- Local starters: `~/.smolvm/starters/`
- Cloud starters: `registry.smolvm.dev/starters/` (or any S3-compatible store)
- Community starters: `smolvm starter search python-ml`

**Built-in starters** (maintained by smolvm team or community):

| Starter | What's inside | Use case |
|---|---|---|
| `claude-code` | Node + Claude Code + non-root user + fixes | AI coding agent |
| `all-agents` | Claude Code + Codex + Pi-Mono + Gemini CLI | Multi-agent experiments |
| `python-ml` | Python 3.13 + pip + numpy/pandas/scipy/torch | ML experiments |
| `node-fullstack` | Node 22 + npm + git + common tools | Web development |
| `rust-dev` | Rust toolchain + cargo | Systems programming |
| `browser` | Chromium + Playwright + Node | Browser automation |
| `db-sandbox` | PostgreSQL + SQLite + Redis | Database testing |

### 5.4 Clone, Work, Merge

The git branch/merge workflow, but for VMs.

**Use case:** You have a working VM. You want to try two different approaches
to a problem. Clone the VM, run different agents in each clone, compare
results, merge the winner back.

```bash
# Start from a known-good state
smolvm checkpoint create my-vm --name baseline

# Clone into two experimental VMs
smolvm clone my-vm --name approach-a
smolvm clone my-vm --name approach-b

# Run different agents/strategies
smolvm exec approach-a -- claude -p "Refactor using strategy A"
smolvm exec approach-b -- claude -p "Refactor using strategy B"

# Compare results
smolvm diff approach-a approach-b
# Shows filesystem differences: which files changed, how they differ

# Merge the winner back
smolvm merge approach-a --into my-vm --files
# Applies file changes from approach-a to my-vm

# Clean up
smolvm delete approach-a approach-b
```

**What "merge" means for VMs:**
- **File-level merge** (like git): apply file changes from source to target
- NOT process-level merge (impossible to merge two running systems)
- Merge conflicts resolved the same way as git: manual intervention or
  "theirs wins" / "ours wins" strategies
- The diff is a comparison of overlay filesystem snapshots

**Implementation complexity:** Medium.
- Clone: easy (copy overlay + metadata)
- Diff: straightforward (mount both overlays read-only, run `diff -rq`)
- Merge: tractable for files, impossible for process state

### 5.5 Local-to-Cloud Push/Pull

The ultimate differentiator: develop locally on smolvm, push to cloud for
production. Pull cloud state back to local for debugging. Like `git push/pull`,
but for your entire execution environment.

```bash
# === Develop locally ===
smolvm create dev-vm --from claude-code
smolvm exec dev-vm -- git clone https://github.com/my-org/my-repo
smolvm exec dev-vm -- claude -p "Set up the project and run tests"
smolvm checkpoint create dev-vm --name ready

# === Push to cloud ===
smolvm push dev-vm ready --to cloud
# Uploads: overlay image + metadata + Smolfile
# Compresses and transfers only changed blocks (like rsync)

smolvm cloud run dev-vm --from ready
# Boots in cloud from the pushed checkpoint

# === Or fetch cloud state to local ===
smolvm pull cloud-vm latest
# Downloads checkpoint to local
smolvm create local-debug --from cloud-vm/latest
# Debug production issues locally with full state
```

**What gets pushed/pulled:**
- Overlay disk image (files + installed packages)
- VM metadata (CPU, memory, network config)
- Smolfile (declarative config)
- NOT running process state (not portable across architectures)
- NOT secrets (injected per-environment, never stored in checkpoints)

**Cloud targets:**
- smolvm Cloud (their own hosting, if built) — tightest integration
- Any S3-compatible store (checkpoint storage only) — most flexible
- Generic Linux host with KVM + smolvm (self-hosted) — full control

**Technical requirements:**
- Portable checkpoint format (disk images + metadata manifest)
- Architecture compatibility check (ARM ↔ x86 not portable with libkrun)
- Compression + deduplication for transfer
- Incremental push (only changed blocks, like `rsync --checksum`)
- Authentication + encryption for cloud storage
- Content-addressable storage for deduplication across starters

### 5.6 Run Anything (Not Just Coding Agents)

smolvm's value proposition extends beyond coding agents. The VM can run any
workload — it's a general-purpose local VM platform.

| Workload | Example | Why smolvm |
|---|---|---|
| **Data pipelines** | Pull data, transform, push results | Isolated env, reproducible |
| **ML experiments** | Small-scale training, model evaluation | Free GPU passthrough (future) |
| **CI/CD** | Run tests in isolated environments | Fast boot, clean teardown |
| **Browser automation** | Playwright/Puppeteer + headless Chromium | Proven on smolvm (smolvm-manager) |
| **Database sandboxes** | Spin up PostgreSQL/SQLite for testing | Checkpoint before migration, restore on failure |
| **Security research** | Malware analysis in isolated VMs | Hardware-level isolation |
| **Education** | Disposable learning environments | Free, no cloud account needed |
| **API development** | Run mock servers, test integrations | Port mapping (once fixed) |

**The key insight:** smolvm is not an "AI sandbox." It's a general-purpose
local VM platform. AI agents are the highest-value initial use case because
they benefit most from fast boot + isolation + checkpoints. But the platform
serves any workload that needs an isolated, reproducible environment.

---

## Part 6: Cloud-Hosted smolvm

### 6.1 What a Cloud Service Would Need

| Component | Purpose |
|---|---|
| **Multi-node hosting** | Run VMs on KVM-enabled cloud servers |
| **API gateway** | HTTPS + auth wrapper around the local REST API |
| **Checkpoint storage** | S3-compatible object store for snapshots |
| **User isolation** | Each user's VMs isolated from others |
| **Billing** | Per-second or per-hour metering |
| **Dashboard** | Web UI for VM management |
| **Starter registry** | Browse and pull community starters |
| **CDN** | Fast starter/checkpoint distribution globally |

### 6.2 Architecture Options

**Option A: Bare metal (simplest, cheapest)**

Rent KVM-enabled servers (Hetzner, OVH, dedicated hosts). Run smolvm serve
directly on host. API gateway (Caddy/nginx) adds HTTPS + auth.

- Pros: Simplest, cheapest, full control
- Cons: Manual scaling, no geographic distribution
- Best for: MVP, small team

**Option B: smolvm on Fly Machines**

Each user gets a Fly Machine running smolvm. Fly handles networking, scaling,
global distribution.

- Pros: Global distribution, managed infra
- Cons: Nested virtualization (VM inside VM) — may not work with libkrun
- Best for: If nested virt works, this is the fastest path to global hosting

**Option C: smolvm + Kubernetes**

Each smolvm instance runs as a pod with KubeVirt for VM support.

- Pros: Enterprise-ready, auto-scaling, multi-tenant
- Cons: Most complex, highest overhead
- Best for: Enterprise deployments

**Option D: Pack mode distribution (no cloud needed)**

smolvm Pack creates portable executables. Package a VM with all tools,
distribute the binary. Users run on their own infra.

- Pros: No cloud hosting cost, no vendor lock-in
- Cons: No centralized management, no push/pull workflow
- Best for: Air-gapped environments, edge deployment

### 6.3 Using CX01–CX03 Platforms as the Orchestration Layer

An interesting option: use the platforms we already tested as the control
plane for smolvm hosts. Each platform brings different strengths to the
orchestrator role.

**Cloudflare Workers as control plane**

The Worker handles auth, routing, billing, tenant isolation. Durable Objects
track per-tenant VM state. KV stores config and starter manifests. The Worker
proxies requests to smolvm hosts running on dedicated servers.

```
User → Cloudflare Worker (auth, routing, billing)
         → Durable Object (tenant state, VM registry)
         → smolvm host (Hetzner/OVH bare metal)
              → smolvm REST API (create/exec/checkpoint)
```

- Pros: Global edge routing, DDoS protection, Durable Objects for state,
  KV for config, R2 for checkpoint storage
- Cons: Can't run smolvm inside a Worker (no KVM). Workers are the brain,
  smolvm hosts are the muscle.
- Secret handling: Workers can hold API keys and inject them per-request
  to smolvm's `env` parameter — keys never stored on smolvm hosts

**Deno Deploy as control plane**

Similar to Cloudflare but with Deno's secret placeholder model at the
orchestrator level. The orchestrator holds secrets, injects them when
proxying exec requests to smolvm hosts.

```
User → Deno Deploy (auth, secret management)
         → smolvm host (bare metal)
              → smolvm REST API
```

- Pros: Secret placeholder model protects keys even from the orchestrator
  code itself, clean TypeScript SDK for building the control plane
- Cons: Same limitation — can't run smolvm inside Deno Deploy

**Fly Machines as smolvm hosts**

Unlike the other two, Fly could actually HOST smolvm — not just orchestrate it.
If Fly Machines have KVM access (bare-metal or nested virt enabled), smolvm
runs directly inside the Machine. Sprites become the auto-scaling layer.

```
User → Fly API (auth, scaling, billing)
         → Fly Machine (smolvm installed, KVM-enabled)
              → smolvm serve (REST API on internal port)
              → N smolvm VMs per Machine
```

- Pros: Global distribution, auto-scaling, wake-on-demand, Fly handles
  networking and load balancing. smolvm handles VM isolation.
- Cons: Nested virt is the open question. Firecracker (Fly's VMM) inside
  libkrun (smolvm's VMM) may not work. Needs testing.
- If it works: This is the fastest path to "smolvm Cloud" without building
  any infrastructure.

**Hybrid: Cloudflare control plane + Fly compute**

Best of both worlds. Cloudflare Workers handle auth/routing/billing (what
they're best at). Fly Machines run smolvm (what they're best at).

```
User → Cloudflare Worker (auth, routing, billing, R2 checkpoint storage)
         → Fly Machine (smolvm serve, KVM-enabled)
              → smolvm VMs
```

This is probably the most production-viable architecture: Cloudflare's edge
network for the API surface, Fly's compute for the actual VMs, R2 for
checkpoint/starter storage.

### 6.4 Cloud API Surface

Same as local API, plus cloud-specific endpoints:

```
# Authentication
POST   /api/v1/auth/token                     → get API token

# Checkpoint sync
POST   /api/v1/checkpoints/{id}/push          → upload to cloud storage
POST   /api/v1/checkpoints/{id}/pull          → download from cloud
GET    /api/v1/starters                       → list available starters
POST   /api/v1/sandboxes --from starter       → boot from cloud starter

# Usage & billing
GET    /api/v1/usage                          → current period usage
GET    /api/v1/usage/history                  → historical usage
```

### 6.5 Business Model

| Tier | What | Price |
|---|---|---|
| **Free** | Local use (already free, always will be) | $0 |
| **Pro** | Cloud hosting, per-second billing, 10 concurrent VMs | ~$0.01/min |
| **Team** | Shared starters, team management, 50 concurrent VMs | ~$0.008/min |
| **Enterprise** | Dedicated instances, compliance, SLAs | Custom |
| **Starter marketplace** | Community-created starters (free + premium) | Revenue share |

---

## Part 7: OpenSandbox's execd — A Model for smolvm's In-VM Agent

OpenSandbox (CX05, Alibaba) takes a protocol-first approach that smolvm should
study. Their key insight: **inject a lightweight daemon (execd) into every
container** that provides a rich API surface from inside the VM.

### What execd does

| Capability | API | Why it matters |
|---|---|---|
| **File CRUD** | Upload, download, read, write, delete, search (glob), permissions, mv | Eliminates smolvm's "pipe through exec" hack for file I/O |
| **Commands** | Foreground + background exec, SSE streaming, interrupt, status polling | Richer than smolvm's synchronous exec |
| **Code Interpreter** | Jupyter-based, multi-language (Python, JS, TS, Go, Bash), stateful sessions | Entirely new capability — no platform has this |
| **Metrics** | CPU/memory monitoring, real-time SSE watch stream | Eliminates need for external stats endpoint |

### Why this matters for smolvm

smolvm already has a guest agent (`smolvm-agent` crate, communicates via vsock).
Today it only handles exec. Extending it with execd-like capabilities would:

1. **Solve the file I/O problem** without fixing virtiofs volume mounts
2. **Add metrics** without external monitoring
3. **Enable code interpreter** for data science / ML workloads
4. **Keep the same REST API surface** — just proxy to the in-VM agent

### The protocol-first lesson

OpenSandbox defined two OpenAPI specs first, then built SDKs + runtimes to
match. The runtime is swappable — Docker today, potentially smolvm microVMs
tomorrow. If smolvm adopted OpenSandbox's execution spec (`execd-api.yaml`),
it would get:

- Compatibility with OpenSandbox's multi-language SDKs (Python, TS, Java, C#)
- A proven API contract designed for AI agent workloads
- The entire OpenSandbox example ecosystem (Claude Code, Gemini, browser, etc.)

**The dream integration:** smolvm's 300ms boot + hardware isolation +
OpenSandbox's execd daemon + egress sidecar. MicroVM security with
container-grade DX.

---

## Part 8: just-bash as a Web DX Layer

[just-bash](https://github.com/vercel-labs/just-bash) is a TypeScript project
from Vercel Labs that reimplements a bash environment entirely in JavaScript —
no real shell, no real kernel, no real binaries. Commands like `cat`, `grep`,
`sed`, `jq`, and `curl` are all TypeScript functions running against a virtual
in-memory filesystem. It runs in Node.js and in the browser.

### How it works

| Aspect | just-bash | smolvm |
|---|---|---|
| **Isolation** | Simulated (JS process) | Real (hardware VM via libkrun) |
| **Filesystem** | In-memory virtual | Real Linux ext4 |
| **Binaries** | None (reimplemented in TS) | Any Linux binary |
| **Boot** | Instant (it's just JS) | ~300ms |
| **Can run node/python/git** | No | Yes |
| **Can compile code** | No | Yes |
| **Runs in browser** | Yes | No |
| **Security** | Process-level (not DOS-proof) | Hardware-level VM |
| **Cost** | Zero (client-side) | Zero (local) or per-usage (cloud) |

They solve opposite problems: just-bash is fast and fake, smolvm is real and
isolated. This makes them complementary, not competitive.

### Integration concept: Tiered Execution

A web frontend for smolvm could use just-bash as the lightweight tier:

```
┌─────────────────────────────────────────────────┐
│  Web UI (browser)                               │
│                                                 │
│  ┌──────────────┐    ┌────────────────────────┐ │
│  │  just-bash   │    │  xterm.js terminal     │ │
│  │  (in-browser │    │  (connected to smolvm  │ │
│  │   sandbox)   │    │   via WebSocket/HTTP)  │ │
│  └──────┬───────┘    └──────────┬─────────────┘ │
│         │                       │               │
│    Light tasks             Heavy tasks          │
│    - file browsing         - compile code       │
│    - script preview        - run tests          │
│    - grep/sed/jq           - install packages   │
│    - offline/preview       - run agents         │
│                            - real isolation     │
└─────────────────────────────────────────────────┘
                              │
                    POST /api/v1/sandboxes/{id}/exec
                              │
                    ┌─────────▼──────────┐
                    │  smolvm serve      │
                    │  (local or cloud)  │
                    └────────────────────┘
```

**Escalation triggers** — start in just-bash, escalate to smolvm when:
- Command needs a real binary (`node`, `python`, `gcc`, `git`)
- Command needs real network (`curl` to a non-allowlisted URL)
- Command needs more than ~100MB filesystem
- User requests "real mode" explicitly
- Agent needs hardware-level isolation

### Concrete use cases

**1. Agent tool with graceful degradation**

An AI agent gets a bash tool that tries just-bash first, falls back to smolvm:

```typescript
// Pseudocode: tiered bash tool for AI agents
async function exec(cmd: string): Promise<ExecResult> {
  // Try just-bash first (instant, free, no server needed)
  if (canRunInJustBash(cmd)) {
    return justBash.exec(cmd);
  }
  // Escalate to smolvm (real VM, real binaries)
  return smolvmClient.exec(sandboxId, cmd);
}
```

This is useful for agent workloads where many commands are simple file ops
(`cat`, `grep`, `echo > file`) but occasional commands need real execution.
The agent doesn't need to know which tier it's on.

**2. Offline fallback for cloud-hosted smolvm**

If smolvm goes cloud (Part 6), just-bash serves as the offline mode:
- User loses connectivity → seamlessly falls back to just-bash
- Quota exhausted → just-bash keeps working for read/preview tasks
- Prototyping scripts → instant feedback without VM boot

**3. Web playground / documentation**

A "Try smolvm" web experience where visitors can run commands in-browser
without spinning up real VMs. Just-bash handles the demo; the "upgrade to
real VM" button provisions an actual smolvm sandbox.

**4. Preview before commit**

In a git-for-VMs workflow (Part 5), just-bash could preview file changes
before committing them to the real VM filesystem. Edit files in the virtual
FS, preview the diff, then push to the smolvm sandbox.

### API compatibility layer

just-bash's `Sandbox` class already matches Vercel's sandbox API shape:

```typescript
// just-bash API
const sandbox = await Sandbox.create({ cwd: "/app" });
await sandbox.writeFiles({ "/app/hello.sh": 'echo "hello"' });
const cmd = await sandbox.runCommand("bash /app/hello.sh");
```

smolvm's TypeScript SDK (Tier 3 roadmap) should match this same interface:

```typescript
// smolvm SDK (proposed — same shape)
const sandbox = await SmolSandbox.create({ image: "alpine" });
await sandbox.writeFiles({ "/app/hello.sh": 'echo "hello"' });
const cmd = await sandbox.runCommand("bash /app/hello.sh");
```

Same interface, different backend. An agent or web app could swap between them
with a one-line config change. This aligns with OpenSandbox's protocol-first
lesson (Part 7) — define the API shape, then let the runtime be swappable.

### What this means for the roadmap

just-bash doesn't change smolvm's core roadmap (Parts 1–7). It's a **DX
layer on top** — specifically relevant to:

| Roadmap Item | How just-bash helps |
|---|---|
| **Tier 3: TypeScript SDK** | Use just-bash's Sandbox API as the interface template |
| **Part 5: Git-for-VMs** | Preview/diff files in-browser before pushing to VM |
| **Part 6: Cloud-hosted smolvm** | Offline fallback, web playground, quota overflow |
| **Part 7: execd integration** | just-bash as the "light execd" for browser-side ops |

**Priority:** Low (nice-to-have). Build smolvm's core features first. Add
just-bash integration when building the web UI or cloud dashboard.

---

## Appendix A: Feature-by-Feature Gap Matrix

Full parity analysis. Implementation difficulty: Easy (days), Medium (weeks),
Hard (months), Architectural (fundamental redesign).

| Feature | Sprites | Deno | smolvm Today | Parity Target | Difficulty |
|---|---|---|---|---|---|
| **Checkpoint/Restore** | 400ms / 14s | 13s / 2.5s | None | <500ms / <1s | Hard |
| **File copy API** | REST PUT/GET | SDK methods | Exec workaround | REST PUT/GET | Medium |
| **Pre-installed agents** | All 4 agents | Deno+Python | Nothing | Starter images | Medium |
| **Egress filtering** | Basic | Transparent proxy | All-or-nothing | Domain allowlist | Medium (branch exists) |
| **Secret placeholders** | No | Yes | No | Orchestration layer concern | N/A (not smolvm's job) |
| **Inbound HTTP** | Port 8080 | exposeHttp() | Broken | Fix port mapping | Medium |
| **Within-VM parallelism** | Yes | Yes | Serial | Not planned (use fleet) | Hard |
| **SDK (TypeScript)** | npm | JSR | None (REST only) | npm package | Easy |
| **SDK (Python)** | No | No | None | PyPI package | Easy |
| **Resource monitoring** | No | No | None | Stats endpoint | Easy |
| **Fleet health API** | listSprites() | No | list+get | Add health endpoint | Easy |
| **Documentation** | 3/5 | 3/5 | 1/5 | 4/5 | Medium |
| **Volume mounts** | N/A (REST API) | SDK methods | Buggy | Fix virtiofs | Medium |
| **Port mapping** | Works | exposeHttp() | Broken | Fix libkrun | Medium |
| **Overlay auto-resize** | N/A | N/A | Manual resize2fs | Auto on create | Easy |
| **Git clone** | Works | Broken | Works (via apk) | Already works | Done |
| **Cross-VM parallelism** | Yes | Errors | Yes | Already works | Done |
| **Boot speed** | ~500ms | ~1-2s | ~300ms | Already fastest | Done |
| **Cost** | Per-usage | Per-usage | Free | Free forever | Done |
| **Open source** | No | No | Apache 2.0 | Apache 2.0 | Done |

---

## Appendix B: Existing Building Blocks in smolvm

What smolvm already has that can be leveraged for the roadmap:

| Building Block | What It Is | Enables |
|---|---|---|
| **Pack mode** | Portable VM executables | Distribution, starters, air-gapped deployment |
| **MicroVM persistence** | Files survive stop/start | Simplifies checkpoint (just snapshot the disk) |
| **OCI image support** | Pull any Docker image | Starter images via Docker Hub |
| **REST API** | Clean HTTP CRUD with OpenAPI spec | SDK auto-generation, cloud API gateway |
| **Smolfile** | Declarative TOML config | Reproducible VMs, starter definitions |
| **`overlay_gb` parameter** | Resizable disk | Large workloads (all 4 agents in 4GB) |
| **Cross-VM parallelism** | True parallel fleet execution | Agent orchestration at scale |
| **Network policy branch** | VMM-level egress filtering (in progress) | Domain allowlists without userspace proxies |
| **Two-disk architecture** | `/dev/vdb` overlay + `/dev/vda` storage | Separate concerns: OS changes vs data |
| **`smolvm serve`** | Production-ready HTTP server (Axum + Tokio) | API gateway, cloud hosting |

---

## Appendix D: Track B Implementation Log

What was actually built for Track B (SDKs, Docs, and related contributions).

### Completed Tasks

| Task | What was built | Location |
|------|---------------|----------|
| **T03** | Auto-resize overlay FS | `smolvm-repo/src/storage.rs` |
| **T05** | `--no-persist` flag for serve | `smolvm-repo/src/cli/serve.rs` |
| **T07** | Cold checkpoint/restore | `smolvm-repo/src/api/handlers/checkpoints.rs` |
| **T12** | File copy via exec channel | `sdk-ts/sandbox.ts` (writeFile/readFile) |
| **T14** | Resource stats endpoint | `smolvm-repo/src/api/handlers/stats.rs` |
| **T17** | TypeScript SDK | `sdk-ts/` (11 files, 28/28 tests pass) |
| **T18** | Python SDK | `sdk-py/` (10 files, 27/27 tests pass) |

### TypeScript SDK (`@smolvm/sdk`)

**Location:** `container-experiments/CX04-smolvm/sdk-ts/`

10 files, type-checks clean (`deno check mod.ts`):

| File | Purpose |
|------|---------|
| `mod.ts` | Module entry point, all public exports |
| `smolvm-client.ts` | `SmolvmClient` — top-level entry point |
| `client.ts` | `SmolvmHttpClient` — low-level HTTP transport |
| `sandbox.ts` | `Sandbox` class — exec, sh, file I/O, stats |
| `microvm.ts` | `MicroVM` class — persistent VM variant |
| `fleet.ts` | `SandboxFleet` — multi-VM orchestration |
| `types.ts` | All TypeScript interfaces (from OpenAPI spec) |
| `test.ts` | Integration test suite (requires `smolvm serve`) |
| `deno.json` | Package config (`@smolvm/sdk` v0.1.0) |
| `README.md` | SDK documentation with examples |

**API surface:**

```typescript
import { SmolvmClient } from "@smolvm/sdk";

const client = new SmolvmClient();  // defaults to localhost:8080 or SMOLVM_URL

// Sandbox lifecycle
const sandbox = await client.createAndStart("my-vm", { network: true });
await sandbox.sh("echo hello");
await sandbox.exec(["node", "--version"]);
await sandbox.runCommand("cat /etc/os-release");  // just-bash compat

// File I/O (via base64 exec channel — no Rust changes needed)
await sandbox.writeFile("/app/main.ts", 'console.log("hi");');
const content = await sandbox.readFile("/app/main.ts");
await sandbox.writeFiles({ "/app/a.ts": "...", "/app/b.ts": "..." });
const files = await sandbox.listFiles("/app");
const exists = await sandbox.exists("/app/main.ts");

// Stats (requires T14 Rust PR)
const stats = await sandbox.stats();  // cpus, memory, disk sizes

// Fleet
const fleet = await client.createFleet("worker", 3, { network: true });
await fleet.execAll("echo hello");       // same command on all
await fleet.execEach(["a", "b", "c"]);   // different per sandbox
await fleet.cleanup();

// MicroVMs
const vm = await client.createMicroVM("my-vm", { cpus: 4, memoryMb: 4096 });
await vm.start();
await vm.sh("echo hello");
await vm.cleanup();
```

### Python SDK (`smolvm`)

**Location:** `container-experiments/CX04-smolvm/sdk-py/`

10 files, 27/27 integration tests pass against live `smolvm serve`:

| File | Purpose |
|------|---------|
| `pyproject.toml` | Package config (smolvm v0.1.0, requires httpx) |
| `smolvm/__init__.py` | Module entry point, all public exports |
| `smolvm/smolvm_client.py` | `SmolvmClient` — top-level entry point |
| `smolvm/client.py` | `SmolvmHttpClient` — low-level async HTTP transport |
| `smolvm/sandbox.py` | `Sandbox` class — exec, sh, file I/O, stats, checkpoint |
| `smolvm/microvm.py` | `MicroVM` class — persistent VM variant |
| `smolvm/fleet.py` | `SandboxFleet` — multi-VM orchestration |
| `smolvm/types.py` | All dataclass types (from OpenAPI spec) |
| `test_sdk.py` | Integration test suite (requires `smolvm serve`) |
| `README.md` | SDK documentation with examples |

**API surface:**

```python
import asyncio
from smolvm import SmolvmClient

async def main():
    client = SmolvmClient()

    # Sandbox lifecycle
    sandbox = await client.create_and_start("my-vm", network=True)
    result = await sandbox.sh("echo hello")
    print(result.stdout)  # "hello\n"

    # File I/O
    await sandbox.write_file("/app/main.py", 'print("hi")')
    content = await sandbox.read_file("/app/main.py")

    # Checkpoints
    await sandbox.stop()
    ckpt = await sandbox.checkpoint()
    restored = await client.restore_checkpoint(ckpt.id, "my-vm-v2")

    # Fleet
    fleet = await client.create_fleet("worker", 3, network=True)
    results = await fleet.exec_all("echo hello")
    await fleet.cleanup()

    await sandbox.cleanup()
    await client.close()

asyncio.run(main())
```

### Rust PRs (4 changes, all compile + 131 tests pass)

**T03 — Auto-resize overlay filesystem** (`src/storage.rs`)

Added `resize_ext4_filesystem()` function (~55 lines). Called from
`copy_disk_from_template()` after extending the raw disk file.

- Runs `e2fsck -f -p` for clean filesystem check
- Runs `resize2fs` to expand ext4 to fill the disk
- Graceful fallback: warns but doesn't error if tools not found
- **Fixes:** Users stuck at 487MB filesystem even with `overlay_gb: 4`

**T14 — Resource stats endpoint** (`src/api/handlers/stats.rs`, `src/api/types.rs`, `src/api/mod.rs`)

New `GET /api/v1/sandboxes/{id}/stats` endpoint (~80 lines).

Returns: sandbox name, state, pid, configured CPUs + memory, network flag,
overlay and storage disk file sizes (apparent/logical).

- New types: `ResourceStatsResponse`, `DiskStats`
- Registered in OpenAPI spec + Swagger UI
- Also wired into TypeScript SDK as `sandbox.stats()`

**T05 — DB lock fix** (`src/cli/serve.rs`)

Added `--no-persist` flag to `smolvm serve` (~15 lines).

When set, creates a temporary database in `/tmp/smolvm-ephemeral-{pid}/`
instead of the shared default path. All DB operations work normally but
don't conflict with CLI commands running in another terminal.

- **Fixes:** "Database already open" error when running `smolvm sandbox ls`
  while `smolvm serve` is running

**T07 — Cold checkpoint/restore** (`src/api/handlers/checkpoints.rs`, `src/api/mod.rs`)

New checkpoint system (~460 lines). Four endpoints:

- `POST /api/v1/sandboxes/{id}/checkpoint` — create a cold checkpoint (VM must be stopped)
- `GET /api/v1/checkpoints` — list all checkpoints (newest first)
- `POST /api/v1/checkpoints/{id}/restore` — restore into a new sandbox
- `DELETE /api/v1/checkpoints/{id}` — delete a checkpoint

Implementation details:
- Checkpoints stored at `~/.cache/smolvm/checkpoints/{id}/`
- Each checkpoint contains: `metadata.json`, `overlay.raw`, `storage.raw`
- Uses `tokio::task::spawn_blocking` for all filesystem I/O
- Restore uses `ReservationGuard` RAII pattern for atomic sandbox name reservation
- Creates `AgentManager` via `for_vm_with_sizes` to handle custom disk sizes
- All 4 endpoints registered in OpenAPI spec + Swagger UI
- SDK support in both TypeScript (`sandbox.checkpoint()`, `client.restoreCheckpoint()`)
  and Python (`sandbox.checkpoint()`, `client.restore_checkpoint()`)
- **Unblocks:** T08 (starters), T09 (clone/diff), T11 (push/pull)

### Not Yet Done

| Task | Status | Notes |
|------|--------|-------|
| **T15** | Not started | Remove fake SDK refs from smolvm website |
| **T16** | Not started | Document REST API (link OpenAPI/Swagger from docs) |
| **T19** | Not started | Add tutorials to official docs |

### How to Verify

**TypeScript SDK:**
```bash
cd container-experiments/CX04-smolvm/sdk-ts
deno check mod.ts                    # type-check (no server needed)
smolvm serve &                       # start server in background
deno run --allow-net --allow-env test.ts  # 28/28 integration tests
deno run --allow-net --allow-env test-checkpoint.ts  # checkpoint test (requires T07 PR)
```

**Python SDK:**
```bash
cd container-experiments/CX04-smolvm/sdk-py
smolvm serve &                       # start server in background
python3 test_sdk.py                  # 27/27 integration tests
```

**Rust PRs:**
```bash
cd container-experiments/CX04-smolvm/smolvm-repo
cargo check                          # compile check (clean)
cargo test                           # 131 tests, all pass

# T03: create sandbox with overlay_gb:4, exec df -h → should show ~3.9GB
# T05: smolvm serve --no-persist → in another terminal, smolvm sandbox ls works
# T07: POST /api/v1/sandboxes/test/checkpoint → creates checkpoint dir
#      GET /api/v1/checkpoints → lists checkpoints
#      POST /api/v1/checkpoints/{id}/restore → restores into new sandbox
# T14: curl http://localhost:8080/api/v1/sandboxes/test/stats → JSON response
```
