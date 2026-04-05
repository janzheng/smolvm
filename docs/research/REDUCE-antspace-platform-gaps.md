# Antspace Platform Gaps → smolvm Phase 8

**Status:** ready
**From:** reverse engineering of Anthropic's Antspace (https://aprilnea.me/en/blog/reverse-engineering-claude-code-antspace), gap analysis in `antspace-claude-code.md`
**Task:** `-> TASKS.md` Phase 8: Agent Platform

## Problem

Antspace validates our architecture but ships 6 capabilities we lack. Without these, smolvm is a sandbox manager — with them, it's an agent platform. The gap is the difference between "run code in a VM" and "agents boot, discover tools, do work, report status, and survive failures."

## Sources

- [antspace-claude-code.md](antspace-claude-code.md) — full reverse engineering analysis + gap table
- Blog: https://aprilnea.me/en/blog/reverse-engineering-claude-code-antspace
- TASKS-MAP.md Phase 8 — existing task breakdown

## Investigation

### What Antspace gets right that we need

**1. MCP servers in sandbox (highest leverage)**
Antspace runs MCP servers (supabase, codesign) inside the VM as part of lifecycle. Agents get tools automatically — no configuration, no setup. This is what makes their sandbox a *platform*: the agent boots and can immediately discover what it can do.

Our sandboxes are blind — agents exec into them but have no tool discovery. Adding MCP means any MCP-compatible agent (Claude Code, Cursor, custom) connects and works. This is the core differentiator for "we own the stack."

Implementation: MCP server runner as part of sandbox lifecycle → built-in servers (fs, exec, git) → MCP proxy to expose to host/other sandboxes.

**2. NDJSON status streaming (foundation for everything else)**
Every long operation in Antspace streams structured status: `packaging → uploading → building → deploying → deployed`. Our API is request/response — long operations are black boxes.

Without streaming, work queues can't report progress, agent runs can't show status, and fleet operations are blind. This is infrastructure, not a feature.

Implementation: `application/x-ndjson` response type on sandbox create, agent run, fleet up. Status model: `queued → preparing → running → completed/failed`. CLI renders progress.

**3. Work queue + polling (agent dispatch model)**
Antspace agents poll for work (`/work`), ack completion, and the system retries failures. Our dispatch is imperative: `agent run` blocks until done.

Polling decouples submission from execution. You can submit 100 tasks and let agents pull work as they become available. Failed tasks re-queue. This is the architecture for production multi-agent.

Implementation: Job queue API (submit, poll, ack) → agent worker model → retry with backoff + dead letter.

**4. Session lifecycle hooks (prevent data loss)**
Antspace's pre-stop hooks check for uncommitted git, build errors, TypeScript errors before allowing teardown. `smolctl down` just kills — agent work can be lost.

Implementation: Hook framework on sandbox stop → built-in checks (git dirty, running processes, error state) → `--force` bypass → post-start hooks for auto-setup.

**5. Session recording (audit trail)**
They record all activity for replay. We have no visibility into what an agent did after the fact.

Implementation: Log exec calls, file ops, API calls per sandbox → replay view.

**6. Sandbox identity (foundation for RBAC)**
`/whoami` — sandboxes know who they are: name, owner, labels. Ours are anonymous.

Implementation: Identity endpoint → metadata on create → RBAC levels (owner, read-only, exec-only).

### What we already do better

- **Secret proxy** — vsock reverse proxy is more secure than their env var injection
- **Git-like workflows** — clone/diff/merge/snapshots for multi-agent coordination
- **Fleet orchestration** — batch operations they don't expose
- **Vendor neutrality** — any LLM, any backend, not locked to Anthropic
- **Open CLI + SDKs** — developer-facing; Antspace is internal-only

## Recommendation

Build in this order — each item unblocks the next:

1. **NDJSON streaming** — foundation. Without it, items 3-4 can't report status.
2. **Session lifecycle hooks** — quick win, defensive. Prevents losing work.
3. **MCP servers in sandbox** — the feature that makes smolvm a platform. Highest user impact.
4. **Work queue** — builds on streaming. Production dispatch model.
5. **Sandbox identity** — foundation for RBAC and audit.
6. **Session recording** — audit trail, needs identity first.

Items 1-2 are infrastructure (small, focused). Item 3 is the landmark feature. Items 4-6 are production hardening.

## Implementation Sketch

### NDJSON streaming (item 1)
- Add `Accept: application/x-ndjson` header support to Rust server
- Status enum: `Queued | Preparing | Running | Completed | Failed`
- Each status line: `{"status": "running", "message": "...", "progress": 0.5, "ts": "..."}\n`
- Apply to: `POST /sandboxes` (create), `POST /sandboxes/:id/exec` (long-running), fleet operations
- CLI: `smolctl` renders streaming lines as progress updates
- SDKs: async iterator / generator yielding status objects

### Session lifecycle hooks (item 2)
- Hook registry on sandbox config: `pre_stop: [...]`, `post_start: [...]`
- Built-in hooks: `git-dirty` (check uncommitted), `process-check` (running procs), `error-log` (scan for errors)
- `smolctl down` runs pre-stop hooks, warns on failure, requires `--force` to override
- `smolctl up` runs post-start hooks after sandbox boots (install deps, clone repos, start services)
- Hooks are exec commands inside the sandbox — composable, user-defined

### MCP in sandbox (item 3)
- `mcp_servers` field on CreateSandboxRequest: list of MCP server configs to start
- Lifecycle: servers start after sandbox boot, stop before sandbox stop
- Built-in servers: `filesystem` (read/write/list), `exec` (run commands), `git` (status/commit/diff)
- MCP proxy endpoint: `GET /sandboxes/:id/mcp` — exposes sandbox's MCP servers to external clients
- Discovery: `GET /sandboxes/:id/mcp/tools` — list available tools
- This means: Claude Code (or any MCP client) connects to smolvm API → gets proxied to sandbox's MCP servers → full tool access

### Work queue (item 4)
- `POST /jobs` — submit work (prompt, sandbox config, timeout)
- `GET /work` — agent polls for next job (long-poll or SSE)
- `POST /jobs/:id/ack` — agent claims job
- `POST /jobs/:id/status` — stream NDJSON status updates
- `POST /jobs/:id/complete` — mark done with result
- Retry: exponential backoff, configurable max retries, dead letter queue
- CLI: `smolctl job submit`, `smolctl job ls`, `smolctl job status`

### Sandbox identity (item 5)
- `owner`, `labels`, `metadata` fields on CreateSandboxRequest
- `GET /sandboxes/:id/whoami` — returns identity, owner, labels, created-at
- RBAC: `owner` (full access), `exec` (run commands only), `readonly` (read files only)
- API key scoped to sandbox or owner

### Session recording (item 6)
- Middleware on all sandbox operations: log to append-only event stream
- Events: `exec`, `file_read`, `file_write`, `file_delete`, `mcp_call`, `api_call`
- `GET /sandboxes/:id/sessions` — list sessions
- `GET /sandboxes/:id/sessions/:sid/events` — replay event stream
- Storage: local JSON files per sandbox, rotated by session
