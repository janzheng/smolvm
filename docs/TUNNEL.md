# Remote Access via Cloudflare Tunnel

Access your smolvm server from anywhere using a Cloudflare tunnel. One tunnel serves all sandboxes through the central REST API.

## Prerequisites

```bash
# Install cloudflared
brew install cloudflared
```

No Cloudflare account needed for quick tunnels (uses `trycloudflare.com`).

## Setup

### 1. Start the server with authentication

```bash
# Generate a random token at startup (printed to stderr)
smolvm serve start --listen 127.0.0.1:8080 --generate-token

# Or use a specific token
smolvm serve start --listen 127.0.0.1:8080 --api-token my-secret-token

# Or via environment variable
SMOLVM_API_TOKEN=my-secret-token smolvm serve start --listen 127.0.0.1:8080
```

**Important:** Always use `--generate-token` or `--api-token` when exposing via tunnel. Without auth, anyone with the tunnel URL has full access.

### 2. Start the tunnel

```bash
cloudflared tunnel --url http://localhost:8080
```

Cloudflared prints the public URL to stderr:

```
2024-01-15T10:30:00Z INF | https://random-name-here.trycloudflare.com
```

### 3. Configure the client

```bash
export SMOLVM_URL=https://random-name-here.trycloudflare.com
export SMOLVM_API_TOKEN=<token-from-step-1>
```

### 4. Verify

```bash
deno task ctl health
# Server: https://random-name-here.trycloudflare.com
#   status: ok
#   version: 0.1.21
```

## Usage

Once configured, all smolctl commands work transparently through the tunnel:

```bash
# Create and use a sandbox remotely
deno task ctl up my-vm
deno task ctl sh my-vm "uname -a"
deno task ctl sync push my-vm ./src --to /workspace/src
deno task ctl sh my-vm "cd /workspace/src && npm test"
deno task ctl sync pull my-vm ./results --from /workspace/src/coverage
deno task ctl down my-vm
```

File sync, exec, logs, snapshots — everything goes through the same REST API.

## SDK Usage

### TypeScript

```typescript
import { SmolvmClient } from "./sdk-ts/mod.ts";

const client = new SmolvmClient("https://random-name-here.trycloudflare.com");
// Token is read from SMOLVM_API_TOKEN env var automatically
```

### Python

```python
from smolvm import SmolvmClient

client = SmolvmClient("https://random-name-here.trycloudflare.com")
# Token is read from SMOLVM_API_TOKEN env var automatically
```

## Security

| Do | Don't |
|---|---|
| Use `--generate-token` or `--api-token` | Expose without auth |
| Listen on `127.0.0.1` (localhost only) | Listen on `0.0.0.0` without auth |
| Keep tokens in env vars, not in code | Commit tokens to git |
| Use quick tunnels for dev/testing | Use quick tunnels for production |

For production, use a [named Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with proper access policies.

### What's protected

- All `/api/v1/*` endpoints require `Authorization: Bearer <token>`
- Health, metrics, and Swagger UI remain public (safe for monitoring)
- Each request is validated with constant-time comparison

### What's NOT protected by the tunnel

- The tunnel encrypts transit (HTTPS) but doesn't add auth — that's the bearer token's job
- Sandbox-to-sandbox isolation is handled by VM boundaries, not the tunnel
- Secret proxy keys are separate from the API token

## Troubleshooting

**"cannot reach server"** — Check that `SMOLVM_URL` is set and the tunnel is running.

**"401 Unauthorized"** — Check that `SMOLVM_API_TOKEN` matches the server's token.

**Slow responses** — Quick tunnels route through Cloudflare's nearest PoP. Latency depends on geography. For local dev, use `http://127.0.0.1:8080` directly.

**Tunnel disconnects** — Cloudflared reconnects automatically. Quick tunnels get a new URL on restart; named tunnels keep their URL.
