# Antspace: Anthropic's Internal Container Platform for Claude Code

Source: https://aprilnea.me/en/blog/reverse-engineering-claude-code-antspace

Reverse-engineered analysis of Anthropic's undocumented PaaS ("Antspace") that powers Claude Code Web and the "Baku" web app builder on claude.ai.

---

## Why This Matters for smolvm

Antspace is essentially what we're building with smolvm — but owned by Anthropic and tightly coupled to their stack. The architecture validates our approach (Firecracker microVMs for agent machineing) and shows what a production version looks like. Key differences: **we own the stack**, we're not locked to one LLM vendor, and we can expose the full platform to users.

### Direct Parallels

| Antspace | smolvm | Notes |
|----------|--------|-------|
| Firecracker microVMs | libkrun microVMs | Same isolation philosophy, different hypervisor |
| `environment-runner` (Go binary) | smolvm API server (Deno) | Container lifecycle manager |
| `process_api` as PID 1 | Our init process | Minimal init + API gateway |
| WebSocket tunnel to control plane | cloudflared tunnel | Remote access to machines |
| MCP tools for Supabase | MCP tools (planned) | Tool exposure to agents |
| BYOC (bring your own cloud) | Self-hosted by design | We're BYOC-first |
| Baku templates (Vite+React) | Generic container images | They're app-builder focused, we're agent-focused |

### What We Can Learn

1. **Minimal init is correct** — Antspace runs PID 1 as an epoll event loop monitoring child processes. No systemd, no sshd, no cron. We should stay minimal too.
2. **API gateway on PID 1** — Their init process doubles as a WebSocket API gateway (`--addr 0.0.0.0:2024`). Consider whether our API surface should live at PID 1 level.
3. **Session lifecycle hooks** — Pre-stop hooks check for uncommitted git changes, build errors, etc. before allowing teardown. Smart for agent machines too.
4. **Work polling model** — Agents poll for work, ack jobs, stream status via NDJSON. This is the dispatch model we need for multi-agent.
5. **BYOC as first-class** — They support enterprise self-hosting with `environment-runner` in customer infra. Our model is inherently BYOC.

---

## Architecture Details

### VM Specs (Antspace)
- 4 vCPUs (Intel Xeon Cascade Lake @ 2.80GHz)
- 16GB RAM, 252GB disk
- Linux 6.18.5, ACPI tables signed `FIRECK`/`FCAT`
- No nested virtualization (vmx/svm stripped)

### Process Model
```
PID 1: /process_api --firecracker-init --addr 0.0.0.0:2024
  └─ PID 517: /usr/local/bin/environment-manager task-run
       └─ PID 532: claude (CLI)
```

PID 1 is an epoll event loop monitoring `/proc/*/children` and `/proc/*/status`. Acts as both init and WebSocket API gateway. No systemd, sshd, cron, or logging daemons.

### environment-runner Binary
27MB unstripped Go binary from `github.com/anthropics/anthropic/api-go/environment-manager/`. Key internal packages:

- `api/` — Session ingress, work polling, retry logic
- `claude/` — Code installation, upgrades, execution
- `mcp/servers/` — MCP servers (codesign, supabase)
- `tunnel/actions/deploy/` — Deployment orchestration
- `session/` — Activity recording
- `machine/` — Runtime configuration
- `podmonitor/` — Kubernetes lease management

### Deployment Protocol (Antspace vs Vercel)

**Phase 1: Create deployment**
```
POST to antspaceControlPlaneURL
Authorization: Bearer {antspaceAuthToken}
Body: { app name, metadata }
```

**Phase 2: Upload artifact**
```
POST multipart/form-data
File: dist.tar.gz (size-limited)
```

**Phase 3: Stream status**
```
Response: application/x-ndjson
Status: packaging → uploading → building → deploying → deployed
```

| Aspect | Vercel | Antspace |
|--------|--------|----------|
| Upload | SHA-based per-file dedup | Single tar.gz archive |
| Build | Remote | Local build, upload output |
| Status | Polling | Streaming NDJSON |
| Auth | Token + Team ID | Bearer token + dynamic URL |

---

## Baku: The Web App Builder

"Baku" is the codename for Claude's web app builder. When users request app generation on claude.ai, a Baku environment launches.

### Template & Stack
- Source: `/opt/baku-templates/vite-template`
- Stack: Vite + React + TypeScript
- Dev server managed by supervisord, logs to `/tmp/vite-dev.log`

### Supabase Auto-Provisioning (6 MCP tools)
1. `provision_database` — Create Supabase projects on-demand
2. `execute_query` — Run SQL queries
3. `apply_migration` — Versioned schema changes + auto type generation
4. `list_migrations` — List applied migrations
5. `generate_types` — Regenerate TypeScript types from schema
6. `deploy_function` — Deploy Supabase Edge Functions

Auto-writes `.env.local`:
```
SUPABASE_URL, SUPABASE_ANON_KEY
VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
```

### Session Lifecycle Hooks
Pre-stop hook prevents termination if:
- Uncommitted/unpushed git changes exist
- Vite dev server logs contain errors
- `tsc --noEmit` reports TypeScript errors

### Internal Organization
- Drafts: `.baku/drafts/`
- Explorations: `.baku/explorations/`
- Git author: `claude@anthropic.com`
- Version control: Local-only (no remote configured)
- Default deploy target: Antspace (Vercel as fallback)

---

## BYOC: Bring Your Own Cloud

The `envtype/` package supports two environment implementations:
1. **anthropic** — Firecracker microVMs (Anthropic-hosted)
2. **byoc** — Enterprise customers run `environment-runner` in own infra

### BYOC Characteristics
- Default session mode: `resume-cached` (fastest restarts, state reuse)
- Custom auth injection via `containProvideAuthRoundTripper`
- Smart git handling: checks remote branch existence before fetch
- Sub-types: `antspace` (internal), `baku` (Vite builder)
- Kubernetes integration: `podmonitor` manages lease lifecycle

### BYOC API Endpoints (7 total)

| Endpoint | Purpose |
|----------|---------|
| `/v1/environments/whoami` | Identity discovery |
| Work polling + ack | Job queue management |
| Session context | Configuration retrieval |
| Code signing | Binary verification |
| Worker WebSocket | Real-time tunnel |
| Supabase DB proxy | Database relay |

---

## Dependency Stack

Key dependencies extracted from binary:
- `github.com/anthropics/anthropic/api-go` — Internal SDK
- `github.com/gorilla/websocket` — WebSocket tunnel
- `github.com/mark3labs/mcp-go v0.37.0` — Model Context Protocol
- `github.com/DataDog/datadog-go v5` — Metrics
- `go.opentelemetry.io/otel v1.39.0` — Distributed tracing
- `google.golang.org/grpc v1.79.0` — Session routing
- `github.com/spf13/cobra` — CLI framework

---

## Strategic Implications

Antspace represents full vertical integration:

```
Natural language → Claude generates app (Baku) → Supabase provisioning (MCP) → Deploy to Antspace → Live app
```

This positions Anthropic against Vercel/Netlify (hosting), Replit/Lovable/Bolt (AI codegen), and Supabase/Firebase (backends). Their structural advantage: they own LLM + build runtime + hosting platform.

**Our opportunity**: We're building the same stack but vendor-neutral and user-owned. smolvm can be the open, composable alternative — any LLM, any backend, any hosting target. The "BYOC-first" model means users own their compute and data.

---

## Design Implications for smolvm

### Adopt
- **Minimal init pattern** — PID 1 as event loop + API gateway, nothing else
- **NDJSON status streaming** — For deployment and task status
- **Session lifecycle hooks** — Pre-teardown checks (uncommitted work, running processes)
- **Work polling + ack** — Clean dispatch model for multi-agent
- **MCP tool exposure** — First-class MCP server integration in machine

### Adapt
- **WebSocket tunnel** — They use gorilla/websocket to control plane; we use cloudflared. Consider adding a direct WebSocket option for lower latency
- **Template system** — Baku has opinionated Vite templates; we should support pluggable templates for different agent workloads
- **Code signing** — They verify binaries via MCP codesign server. We need trust verification for agent code

### Avoid
- **Vendor lock-in** — Their whole value prop is the closed loop. Ours is the open one
- **Monolithic binary** — Their 27MB Go binary does everything. Keep our components composable
- **Single-tenant focus** — Baku is one-user-one-machine. We need multi-agent-per-machine and fleet orchestration

### Open Questions
1. Should smolvm's init process also serve as the API gateway (like Antspace's PID 1)?
2. Do we need a work-polling model for agent dispatch, or is our current exec-based approach sufficient?
3. Should we add NDJSON streaming to the smolvm API for status updates?
4. How do we handle MCP server lifecycle inside the machine?

---

## Gap Analysis: Antspace vs smolvm

Detailed comparison of what Antspace does that smolvm doesn't yet.

### What We Already Have (parity or better)

| Capability | Antspace | smolvm | Status |
|-----------|----------|--------|--------|
| MicroVM isolation | Firecracker | libkrun | **Parity** — both hardware-level |
| API auth | Bearer token | Bearer token | **Parity** |
| Container lifecycle | Create/start/stop | Full CRUD + clone/diff/merge | **Ahead** — git-like workflows |
| File transfer | tar.gz upload | tar + multipart + file API + sync | **Ahead** |
| Secret injection | Env vars in VM | vsock reverse proxy (keys never enter VM) | **Ahead** — more secure |
| Machine cloning | Not mentioned | APFS COW clone + diff + merge | **Ahead** |
| Snapshots | Not mentioned | Push/pull export/import | **Ahead** |
| Multi-agent | Single environment per session | Fleet + agent fleet + merge + collect | **Ahead** |
| Remote access | WebSocket to control plane | Cloudflared tunnel | **Parity** |
| CLI | Not user-facing | Full CLI (smolctl) | **Ahead** |
| SDKs | Internal Go SDK only | TypeScript + Python SDKs | **Ahead** |

### What They Have That We Don't

| Capability | What Antspace Does | smolvm Gap | Priority |
|-----------|-------------------|-----------|----------|
| **NDJSON status streaming** | All long operations stream status via `application/x-ndjson` (packaging → uploading → building → deploying → deployed) | Our API is request/response only. No streaming status for machine creation, file uploads, or agent runs. WebSocket exec streams stdout but no structured status. | High |
| **Session lifecycle hooks** | Pre-stop hooks check: uncommitted git, build errors, TypeScript errors. Prevents accidental teardown of dirty state. | `smolctl down` just kills. No pre-teardown checks. Agent work can be lost. | High |
| **Work polling + ack dispatch** | Agents poll a job queue (`/work`), ack jobs, report status. Decoupled producer/consumer. | Our agent dispatch is imperative — `agent run` blocks until done. No job queue, no ack, no retry on failure. | High |
| **MCP server inside machine** | First-class MCP servers run inside the VM (supabase, codesign). Agents get tools automatically. | No MCP integration. Agents in machines can't expose or consume MCP tools. | High |
| **Session recording** | `session/` package records all activity for replay/audit. | No session recording. Can't replay what an agent did. | Medium |
| **Resume-cached sessions** | BYOC default is `resume-cached` — fastest restart, state reuse across sessions. | Machinees persist but no "session resume" concept. No warm-start optimization. | Medium |
| **Code/binary signing** | MCP codesign server verifies binaries before execution. | No trust verification for code pushed into machines. | Medium |
| **Distributed tracing** | OpenTelemetry integration for request tracing across services. | Prometheus metrics only. No distributed tracing, no request correlation. | Low |
| **Deployment pipeline** | Full deploy flow: build locally → upload tar → stream status → live URL. | No deployment from machine. Machine is the end state, not a build step. | Low (different use case) |
| **Template marketplace** | Baku templates for different app types. | Starters exist (claude-code, node-deno, python-ml, universal) but no template authoring or community templates. | Low |
| **Identity/whoami** | `/v1/environments/whoami` — machine knows its own identity, owner, permissions. | Machinees are anonymous. No identity, no ownership, no RBAC. | Medium |

### What We Have That They Don't

| Capability | smolvm | Why It Matters |
|-----------|--------|---------------|
| **Git-like machine workflows** | Clone (APFS COW), diff, merge, snapshots | Fork/merge agent work — critical for multi-agent coordination |
| **Vendor-neutral** | Any LLM, any backend | Not locked to Anthropic's ecosystem |
| **User-facing CLI** | Full smolctl with fleet, agent, sync | Developer-friendly; Antspace is purely API-driven internally |
| **Secret proxy architecture** | vsock reverse proxy, keys never enter VM | More secure than Antspace's env-var injection |
| **Fleet orchestration** | fleet up/down/exec/ls, agent fleet | Batch operations across many machines |
| **File sync watch** | Bidirectional sync with debounce | Local dev with machine execution |
| **Open architecture** | All components composable, swappable | Not a monolithic 27MB binary |
