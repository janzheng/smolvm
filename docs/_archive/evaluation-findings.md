# CX04 Evaluation Findings

Hands-on evaluation of smolvm v0.1.16 for coding agent workloads.
Tested 2026-02-26 on macOS Apple Silicon.

---

## TL;DR

- **Fastest boot** of all 4 platforms tested (~300ms vs 500ms-30s)
- **REST API exists** but is completely undocumented on the site
- **Advertised SDKs don't exist** (npm/pip both 404)
- **Volume mounts are buggy** (create succeeds, files not visible)
- **Free, local, open-source** — only platform with all three
- **86.7% test pass rate** (39/45 capabilities)

---

## Test Results Summary

| Suite | Pass | Fail | Total |
|-------|------|------|-------|
| Basic Sandbox | 29 | 0 | 29 |
| Capabilities | 39 | 6 | 45 |
| Fleet | 8 | 0 | 8 |
| Lifecycle | pass | — | — |
| **Total** | **76** | **6** | **82** |

---

## What Works (and Works Well)

### REST API via `smolvm serve`

The biggest positive surprise. Full HTTP CRUD for sandboxes, microVMs,
containers, and images. OpenAPI 3.1 spec + Swagger UI included. Endpoints
are clean, responses are predictable, error handling is reasonable.

```
POST /api/v1/sandboxes           → Create
POST /api/v1/sandboxes/{id}/start → Start
POST /api/v1/sandboxes/{id}/exec  → Execute command
POST /api/v1/sandboxes/{id}/stop  → Stop
DELETE /api/v1/sandboxes/{id}     → Delete
```

### Boot Speed

Create-to-first-exec in 281ms. This is genuinely fast — faster than any
cloud sandbox. The VM is ready to execute commands almost instantly after
`start` returns.

### Environment Variables

Both CLI (`-e KEY=VALUE`) and API (`env: [{name, value}]`) work correctly.
Multiple vars, special characters, all verified. This was listed as
missing in the pre-evaluation docs — it works.

### Cross-Sandbox Parallelism

Three sandboxes sleeping 1s each complete in 1011ms total — truly parallel.
This means fleet orchestration works: create N sandboxes, run tasks across
them concurrently.

### Persistence

Files and installed packages survive stop/start cycles. This means you can
bootstrap once, stop, and restart later without re-installing.

### OCI Images

Pull and run any OCI image. Tested `node:22-alpine` and `python:3.13-alpine`
successfully. This means you can pre-build images with tools installed.

---

## What Doesn't Work

### Volume Mounts (3 test failures)

The API accepts mount configuration and sandbox creation succeeds, but
files are not visible across the host/guest boundary. This is the most
impactful bug — it blocks the most natural file I/O pattern.

**Workaround:** Use `exec` with shell commands:
```
exec sh -c 'echo "file contents" > /path/to/file'  # write
exec cat /path/to/file                               # read
```

### Port Mapping (1 test failure)

Port mapping config is accepted but connections from host to mapped ports
return "Connection refused".

### Container-in-Sandbox (1 test failure)

Image pull works, but container creation returns 500 with a crun storage
path error.

### Within-Sandbox Parallelism (1 test failure)

Exec calls to the same sandbox are serialized. Three 1-second sleeps take
3043ms. Use multiple sandboxes for parallelism instead.

---

## Documentation Issues

The doc site has significant problems:

1. **Claims SDKs exist that don't:**
   - "npm install smolvm" → 404 on npmjs.com
   - "pip install smolvm" → 404 on PyPI
   - Multiple pages reference these non-existent packages

2. **REST API is undocumented:**
   - The best feature (full REST API) isn't mentioned anywhere on the site
   - OpenAPI spec exists but isn't linked from documentation
   - Swagger UI is available but not referenced

3. **API doc pages are shells:**
   - `/sdk/api-sandbox`, `/sdk/api-microvm`, `/sdk/api-container` exist as
     pages but contain minimal content

4. **Env var support not documented:**
   - Both CLI `-e` and API env array work but aren't covered in docs

---

## Platform Comparison

| | CX01 Cloudflare | CX02 Deno | CX03 Sprites | CX04 smolvm |
|---|---|---|---|---|
| Boot | ~30s cold | ~1-2s | ~500ms | **~300ms** |
| Bootstrap | ~30s Docker | ~13s npm | 0s | ~7s apk |
| Total lifecycle | ~45s | ~29s | **~6.2s** | ~10.1s |
| With pre-built | ~15s | ~16s | ~6.2s | **~3s** |
| Cost | Per-usage | Per-usage | Per-usage | **Free** |
| Location | Cloud | Cloud | Cloud | **Local** |
| Pre-installed | Docker image | Deno+Node+Py | Everything | Nothing |
| Checkpoints | No | Snapshots | Checkpoints | No |
| API style | SDK (npm) | SDK (JSR) | REST + SDK | **REST only** |
| Env vars | Proxy-level | Placeholders | Real | **Real** |
| Docs quality | Good | Good | Good | **Poor** |
| Parallelism | Cross-sandbox | Single only | Cross-sprite | Cross-sandbox |

**Best at:** Boot speed, cost (free), isolation (true VM), local-first
**Worst at:** Documentation, pre-installed tooling, checkpoint/restore

---

## Verdict

smolvm has the best raw performance numbers of any platform tested. The
REST API is solid and makes orchestration viable with just `fetch()`. The
main blockers are all fixable: documentation needs a rewrite, volume mounts
need debugging, and the fake SDK references need removing.

For local agent development and testing, smolvm is already usable via the
REST API. For production workloads, Fly Sprites is more mature (checkpoints,
file API, pre-installed tools). The ideal workflow is develop+test on
smolvm locally, deploy to Sprites for production.
