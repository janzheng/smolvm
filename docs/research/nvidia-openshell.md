# NVIDIA OpenShell — Safe Runtime for Autonomous AI Agents

- **Source:** [NVIDIA OpenShell Docs](https://docs.nvidia.com/openshell/latest/index.html)
- **Repo:** [NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell)
- **PyPI:** [openshell](https://pypi.org/project/openshell/)
- **License:** Apache-2.0
- **Date captured:** 2026-03-16

## TL;DR

NVIDIA OpenShell is an open-source runtime for executing autonomous AI agents in machineed Docker containers with kernel-level isolation. It uses Landlock LSM for filesystem, seccomp for process, network namespace + proxy for network, and a privacy router for inference traffic. It's a **policy-first** approach — declarative YAML controls what agents can access — rather than a VM-first approach like smolvm.

## Key Takeaways

- **Docker-based, not VM-based**: OpenShell runs inside Docker containers, not micro VMs. The isolation comes from Linux kernel security modules (Landlock, seccomp, network namespaces), not hardware virtualization.
- **Gateway/Machine architecture**: A control-plane "gateway" manages machine lifecycle. Machinees are the data plane. Gateway can run local (Docker), remote (SSH), or cloud (reverse proxy).
- **Declarative YAML policies**: All security is policy-driven. Filesystem paths (read-only vs read-write), network endpoints (host+port+binary), process identity (unprivileged, no sudo). Network policies are hot-reloadable without restarting machines.
- **Per-binary network control**: Network policies pair allowed destinations with allowed binaries — both must match. e.g., only `/usr/bin/pip` can reach `pypi.org`. This is more granular than smolvm's current approach.
- **REST endpoint inspection**: For `protocol: rest` + `tls: terminate`, the proxy decrypts TLS and checks HTTP method + path. Can allow GET but deny POST on specific API paths.
- **Privacy/inference routing**: Built-in `inference.local` endpoint routes LLM API calls through a managed proxy that strips machine credentials and injects backend credentials. Supports OpenAI, Anthropic, NVIDIA providers.
- **Supported agents**: Claude Code (full), OpenCode (partial), Codex (needs custom policy), OpenClaw (bundled). Community machine images in separate repo.
- **Python CLI**: `uv tool install -U openshell` then `openshell machine create -- claude`

## Architecture Components

| Component | Role |
|-----------|------|
| **Gateway** | Control-plane API — machine lifecycle, auth boundary, request broker |
| **Machine** | Isolated runtime — container supervision + policy-enforced egress |
| **Policy Engine** | Defense-in-depth enforcement across filesystem, network, process |
| **Privacy Router** | LLM routing — strips creds, injects backend creds, routes by cost/privacy |

## Policy Layers

| Layer | Mechanism | Static/Dynamic |
|-------|-----------|----------------|
| Filesystem | Landlock LSM — read-only vs read-write path lists | Static (locked at creation) |
| Network | Proxy + policy engine — destination + binary matching | Dynamic (hot-reload) |
| Process | seccomp + unprivileged user — no sudo, no setuid | Static (locked at creation) |
| Inference | Privacy router — managed `inference.local` endpoint | Dynamic (hot-reload) |

## Comparison: OpenShell vs smolvm

| Dimension | OpenShell | smolvm |
|-----------|-----------|--------|
| **Isolation model** | Docker container + Linux kernel security (Landlock, seccomp, netns) | Micro VM (libkrun, Hypervisor.framework/KVM) |
| **Isolation strength** | Container-level + kernel hardening. Still shares host kernel. | Full VM — separate kernel, hardware virtualization boundary |
| **Platform** | Linux only (Landlock is Linux-specific). Docker on macOS for local dev. | macOS (Hypervisor.framework) + Linux (KVM). Native on both. |
| **Boot time** | Docker container start (~seconds, depends on image) | 258-831ms (create→first exec) |
| **Policy model** | Declarative YAML with fine-grained per-binary, per-path, per-method controls | Basic — env vars, file mounts, network (outbound works, port mapping WIP) |
| **Network control** | Per-binary endpoint allowlists with HTTP method/path inspection, TLS termination | Outbound HTTPS works, DNS works, no fine-grained policy |
| **Inference routing** | Built-in privacy router with credential management | Not built-in (agent handles own API keys) |
| **Agent support** | Claude Code, OpenCode, Codex, OpenClaw (community images) | Generic — any process via REST API |
| **Architecture** | Client→Gateway→Machine (control/data plane split) | REST API on localhost (single binary) |
| **Deployment** | Local Docker, Remote SSH, Cloud reverse proxy | Local binary only (for now) |

### Where OpenShell is stronger

- **Policy granularity**: Per-binary network rules, HTTP method/path filtering, hot-reload — much more sophisticated than smolvm's current network controls
- **Inference privacy**: Built-in credential management and routing for LLM API calls
- **Enterprise posture**: Gateway architecture supports remote/cloud deployment, multi-machine management, audit trails
- **Agent ecosystem**: Pre-built images for popular coding agents

### Where smolvm is stronger

- **Isolation boundary**: Hardware virtualization (separate kernel) vs container + kernel hardening (shared kernel). VM escape is fundamentally harder than container escape.
- **Boot performance**: Sub-second VM boot vs Docker container startup
- **Platform native**: Runs natively on macOS without Docker. OpenShell needs Docker (and Landlock is Linux-only).
- **Simplicity**: Single binary, simple REST API. No gateway/control-plane overhead.
- **Fleet performance**: 82ms/machine parallel start, cross-machine parallel exec

### What smolvm could learn from OpenShell

1. **Declarative policy YAML** — smolvm should consider a policy file format for filesystem, network, and process constraints
2. **Per-binary network rules** — allow specific binaries to reach specific endpoints
3. **Hot-reloadable network policies** — change network rules without destroying the machine
4. **Inference routing** — a built-in proxy for LLM API calls with credential management
5. **TLS-terminating proxy with HTTP inspection** — allow GET but deny POST on specific API paths
6. **Community machine images** — pre-configured environments for popular agents

## Discussion

### 2026-03-16 — First read

OpenShell and smolvm solve the same problem (safe agent execution) from opposite directions:

- **OpenShell** starts with Docker containers and adds security layers on top (Landlock, seccomp, proxy). The policy engine is the star — very granular control over what agents can do.
- **smolvm** starts with hardware virtualization (micro VMs) which gives stronger isolation by default, but has less sophisticated policy controls.

The interesting question is: **does smolvm need OpenShell-style policies?** The VM boundary already provides strong isolation, but fine-grained network control (which binary can talk to which endpoint, HTTP method filtering) would be valuable for production agent deployments. The privacy router for inference is also compelling — agents shouldn't need raw API keys.

OpenShell's Docker dependency is a meaningful limitation for macOS-native workflows. smolvm's ability to run micro VMs natively on macOS via Hypervisor.framework is a real advantage. But OpenShell's policy engine could potentially be adapted to run in front of smolvm machines.

### Strengths & Weaknesses Summary

**What OpenShell does better:**
1. Policy sophistication — per-binary network rules ("only pip can reach PyPI"), HTTP method/path filtering, hot-reload. smolvm has basic network (outbound works, DNS works, no granular control).
2. Inference privacy — built-in proxy strips agent credentials, injects backend credentials. smolvm agents need raw API keys.
3. Enterprise posture — Gateway architecture, remote/cloud deployment, multi-machine management, audit trails.

**What smolvm does better:**
1. Isolation strength — hardware VM (separate kernel) vs container (shared kernel). VM escape is fundamentally harder than container escape.
2. Boot speed — 258-831ms vs Docker startup (seconds). Massively faster.
3. Native macOS — Hypervisor.framework without Docker. OpenShell needs Docker (Landlock is Linux-only).
4. Simplicity — single binary, REST API on localhost, no control-plane overhead.
5. Fleet parallelism — 82ms/machine parallel start, true cross-machine parallel exec.

### Hybrid Opportunity

smolvm has the stronger isolation boundary. What's missing: OpenShell's policy engine — especially per-binary network rules and the inference privacy router. Adding a declarative YAML policy layer + credential management for LLM APIs would create the strongest option: micro VM isolation + sophisticated policy controls.

---

### 2026-03-22 — Second look (repo deep-dive)

Re-examined the actual repo code (not just docs). Key new findings:

1. **No macOS isolation at all** — confirmed it's a full no-op machine on macOS. Only the proxy and policy evaluation run. smolvm is the only option for real macOS isolation.

2. **K3s dependency is heavy** — the whole thing runs as a K3s cluster inside Docker. Opposite of our single-binary philosophy.

3. **No snapshots/clone/diff** — machines are ephemeral K8s pods. No state management whatsoever. This is a major gap vs smolvm.

4. **Actionable insight — proxy-level filtering**: Our secret proxy (vsock:6100) already intercepts all LLM API traffic. We could add allow/deny rules *at the proxy level* without waiting for upstream TSI fixes:
   - L4: block/allow by destination host
   - L7: block/allow by HTTP method + path (e.g. read-only API access)
   - Denial logging

   This wouldn't cover general network egress (still TSI-blocked), but it would give us fine-grained control over the LLM traffic path specifically — which is the highest-value traffic to control anyway. Low priority but architecturally clean since the proxy is already in the path.

5. **Denial → policy recommendations** — they aggregate blocked requests and suggest policy rules with confidence scores. Nice UX pattern worth remembering.

**Decision:** No code changes. The proxy-level filtering idea is filed for future consideration. The TSI blocker remains the fundamental issue for general egress filtering.

## Source

Captured from:
- https://docs.nvidia.com/openshell/latest/index.html (home)
- https://docs.nvidia.com/openshell/latest/about/overview.html (overview)
- https://docs.nvidia.com/openshell/latest/about/architecture.html (architecture)
- https://docs.nvidia.com/openshell/latest/about/supported-agents.html (agents)
- https://docs.nvidia.com/openshell/latest/machines/index.html (machines)
- https://docs.nvidia.com/openshell/latest/machines/policies.html (policies)
- https://docs.nvidia.com/openshell/latest/inference/index.html (inference)
- https://github.com/NVIDIA/OpenShell (repo)
