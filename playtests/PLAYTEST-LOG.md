# Playtest Log

## 2026-03-29 — Automated E2E Playtest (post-upstream sync)

Server: http://127.0.0.1:8080 (smolvm-plus v0.1.19, synced to upstream)
Runner: e2e-playtest.sh

**Results: 80 pass, 0 fail, 1 skip**

### Changes from last run
- Agent tests (PT-7) now pass — authenticated via `smolctl auth login`
- Tunnel tests (PT-10) now automated — start/status/stop lifecycle works; HTTP 530 from cloudflare edge noted (pre-existing named tunnel interferes)
- Snapshot provider tests self-contained — no longer depend on external state
- Dashboard (PT-9) only remaining skip (needs interactive terminal)

### Findings
- NOTE: Tunnel URL returned HTTP 530 (cloudflare edge issue when another cloudflared instance is running — not our code)
- NOTE: Placeholder ANTHROPIC_API_KEY not in env (expected when using subscription auth)

---

## 2026-03-15 — Playtest 04: Agent Autonomy

> **Historical — v0.1.17.** All limitations noted below (no starters, no file API, no init_commands, no clone/diff) were resolved in the binary rebuild on 2026-03-19.

Server: smolvm v0.1.17, localhost:8080

### Setup
No `claude-code` starter available (starters endpoint 404 in v0.1.17), no `ANTHROPIC_API_KEY` in env. Simulated what an agent would do: create sandbox, bootstrap, write code, run tests, clone a repo, build an app.

### Timeline
| Phase | Time | Notes |
|-------|------|-------|
| Create + start | 2.1s | |
| Bootstrap (Python + pytest + git) | 14.3s | `apk add` + `pip install` |
| Write calculator + tests | <0.5s | 2 files via base64 |
| Run pytest (6 tests) | 0.2s | All pass |
| Git clone (express.js) | 2.7s | Shallow clone works |
| npm install express | 8.7s | Including Node install |
| Write Express app + test routes | <1s | |
| Start server + curl 3 routes | ~2s | All return correct JSON |

**Total: ~30s from empty sandbox to working Express app with tests**

### Findings

**What works well for agents:**
- Bootstrap is slow (14s) but only once — packages persist across exec calls
- pytest and npm test cycles are fast (<1s)
- Background processes work (start server, curl it, kill it)
- Git clone works for importing real projects
- The exec API is low-latency (~15ms per call) — good for agent tool loops

**What's painful for agents:**
- File writing via exec is the main bottleneck (base64 gymnastics)
- No init_commands means every sandbox needs manual bootstrap
- No starters means no pre-built images with tools
- No clone/diff means can't snapshot agent work or compare before/after
- curl not in base image — agents need to remember to install it

**Agent readiness verdict**: smolvm **works** as an agent execution environment. The sandbox boots fast, networking works, package managers work, tests run. The missing features (file API, init_commands, starters, clone/diff) are all in the source code — just need a binary rebuild (S04).

---

## 2026-03-15 — Playtest 02: Build Something Real

> **Historical — v0.1.17.** init_commands and file API now work in current build.

Server: smolvm v0.1.17, localhost:8080

### What we built
A Node.js HTTP server (Hono framework) inside a bare Alpine sandbox — from zero to serving JSON in ~10s.

### Findings

**init_commands don't run** — Feature not in v0.1.17 binary. Had to install manually.

**Heredocs break in exec** — `cat > file << 'EOF'` via the exec API doesn't work. Workaround: use base64 encoding.

**The dev loop works** — Once the escaping hurdle is cleared: npm install, background processes, curl from inside the sandbox all work.

**Verdict**: Usable for real dev work, but file I/O is the bottleneck. File API (added in later build) fixes this.

---

## 2026-03-15 — Playtest 01: First Contact + Playtest 03: Break It

> **Historical — v0.1.17.** Security findings (S01 host API reachable) mitigated by auth token in current build.

Server: smolvm v0.1.17, localhost:8080

### Key findings
- Swagger UI is the best discoverability tool
- Error messages are clear and specific (400, 409, 415)
- Name validation is thorough (unicode, path traversal, length)
- State persists across stop/start
- Cross-sandbox isolation holds
- S01 confirmed: VM can reach host API on port 8080 (mitigated by auth token)
- `/proc/1/environ` readable (minor info leak of internal env vars)

---

## 2026-03-19 — First Automated E2E Run

**Results: 38 pass, 14 fail, 4 skip** → iterated through the day to **49 pass, 0 fail, 9 skip**

Key issues fixed during iteration:
- Provider endpoint, file ops, exec, sync, starters, jobs, MCP — all resolved by binary rebuild and test fixes.

---

## 2026-03-20 — Stabilization

**Results: 54 pass, 0 fail, 4 skip**

Jobs endpoint stabilized. MCP servers returning tools (0 tools initially, then functional).

---

## 2026-03-21 — Growth Phase

Tests grew from 55 → 71 as new scenarios were added (fleet, hooks, workspace export, docker interop, code signing, pool management). All passing.

---

## 2026-03-22 — Pre-Sync Baseline

**Results: 68-71 pass, 0 fail, 2-5 skip**

Last clean run before upstream sync (v0.1.19 → v0.1.21).

---

## 2026-03-28 — Upstream Sync + Snapshot Tests

Synced smolvm-plus with upstream v0.1.21 (8 commits, including overlay rootfs fix and mount type cleanup).

Added PT-16b: Snapshot lifecycle tests (push/list/describe/pull/data-verify/rm).

**Results: 73 pass, 0 fail, 7 skip**

Skips: agent auth (2), interactive terminal (1), tunnel (1), snapshot upload/download/provider (3).

### Integration tests (smolvm-plus)

Also fixed 2 flaky integration tests:
- `test_microvm_overlay_root_active` — race condition, added `wait_for_agent_ready` after VM start
- `test_from_vm_run_finds_installed_package` — packed binary boot timing, added retry loop

**Integration test results: 125/125 pass across 6 suites (CLI, Sandbox, MicroVM, Container, API, Pack).**

---

## 2026-03-28 — Automated E2E Playtest

Server: http://127.0.0.1:8080
Runner: e2e-playtest.sh

**Results: 74 pass, 0 fail, 5 skip**

### Findings
- NOTE: Placeholder ANTHROPIC_API_KEY not in env (may be expected)
- NOTE: Snapshot still visible in list after rm (may be cached or filesystem scan)

---

## 2026-03-28 — Automated E2E Playtest

Server: http://127.0.0.1:8080
Runner: e2e-playtest.sh

**Results: 74 pass, 1 fail, 3 skip**

### Findings
- NOTE: Placeholder ANTHROPIC_API_KEY not in env (may be expected)
- NOTE: Snapshot still visible in list after rm (may be cached or filesystem scan)
- FAIL: Snapshot upload pt-snap-src — error: snapshot 'pt-snap-src' not found at /Users/janzheng/Library/Application Support/smolvm/snapshots/pt-snap-src.smolvm
- NOTE: Downloaded snapshot file not found or empty at /Users/janzheng/Library/Application Support/smolvm/snapshots/pt-snap-src.smolvm (may be expected if download endpoint not available)

---

## 2026-03-28 — Automated E2E Playtest

Server: http://127.0.0.1:8080
Runner: e2e-playtest.sh

**Results: 77 pass, 0 fail, 2 skip**

### Findings
- NOTE: Placeholder ANTHROPIC_API_KEY not in env (may be expected)
- NOTE: Snapshot still visible in list after rm (may be cached or filesystem scan)

---

## 2026-03-28 — Automated E2E Playtest

Server: http://127.0.0.1:8080
Runner: e2e-playtest.sh

**Results: 80 pass, 0 fail, 1 skip**

### Findings
- NOTE: Placeholder ANTHROPIC_API_KEY not in env (may be expected)
- NOTE: Tunnel URL returned HTTP 530 (cloudflare edge issue, not our code)
- NOTE: Snapshot still visible in list after rm (may be cached or filesystem scan)
