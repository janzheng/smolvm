# Playtest 09: Tunnel to the World

**Mission**: Run a web service inside a sandbox and expose it to the public
internet via cloudflared. Can someone on a different machine hit your sandbox?

**Time**: ~20 min

## Entry point

Create a sandbox from `claude-code` starter (which should include cloudflared).

## The challenge

1. Build or write a simple web server inside the sandbox
2. Start it on a port (e.g., 3000)
3. Verify it works from inside the sandbox (`curl localhost:3000` via exec)
4. Start a cloudflared tunnel pointing at it
5. Get the public URL from the tunnel logs
6. Hit that URL from your host machine's browser
7. Hit it from your phone (different network entirely)

## Things to explore

- Is cloudflared actually installed in the starter image? If not, can you
  install it? (`apt-get install cloudflared` or download the binary)
- Does the tunnel start? Can you read the logs to find the URL?
- Latency: how fast is the response through the tunnel?
- Try a more complex app: serve static files, return different content types,
  handle POST requests
- Start two services on different ports with two tunnels. Do both work?
- Kill the tunnel. Does the service keep running? Restart the tunnel — does
  it get a new URL?
- What happens when the sandbox is stopped with a tunnel running?
- Try exposing a WebSocket connection through the tunnel

## Known constraints

- Port mapping from host to sandbox (T02) is broken. Cloudflared tunnels
  work around this by proxying from inside the VM
- Free cloudflared tunnels give random `*.trycloudflare.com` URLs

## What we're really testing

- Network stack works end-to-end (sandbox → cloudflared → internet → user)
- cloudflared is a viable workaround for the port mapping bug
- Real-world usability: can an agent build something and show it to a human?
