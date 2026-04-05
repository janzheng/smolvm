# Deploy smolvm on a KVM VPS

## Prerequisites

- **KVM-capable VPS** — Hetzner Cloud, DigitalOcean, Vultr, AWS bare-metal/dedicated
  - Does NOT work on: Fly Machines, Cloudflare Workers, shared VPS without `/dev/kvm`
- **Linux** — Ubuntu 22.04+ or Debian 12+ recommended
- **Rust toolchain** — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **libkrun** — build from source or install via package manager

## Install libkrun

```bash
# Ubuntu/Debian
sudo apt install -y build-essential libvirglrenderer-dev libepoxy-dev

# Clone and build libkrun
git clone https://github.com/nicovank/libkrun.git
cd libkrun
make
sudo make install  # installs to /usr/local/lib
sudo ldconfig
```

Or copy the pre-built libs to `/opt/smolvm/lib/`.

## Build smolvm

```bash
git clone <your-repo> smolvm
cd smolvm/container-experiments/CX04-smolvm/smolvm-plus

# Build with bundled libkrun path
LIBKRUN_BUNDLE=/opt/smolvm/lib cargo build --release

# Install
sudo mkdir -p /opt/smolvm/bin
sudo cp target/release/smolvm /opt/smolvm/bin/
```

## Set up systemd

```bash
# Create service user with KVM access
sudo useradd -r -s /bin/false -d /var/lib/smolvm smolvm
sudo usermod -aG kvm smolvm
sudo mkdir -p /var/lib/smolvm
sudo chown smolvm:smolvm /var/lib/smolvm

# Create env file
sudo mkdir -p /etc/smolvm
cat <<EOF | sudo tee /etc/smolvm/env
SMOLVM_API_TOKEN=your-secret-token-here
SMOLVM_DATA_DIR=/var/lib/smolvm
EOF
sudo chmod 600 /etc/smolvm/env

# Install and start service
sudo cp deploy/smolvm.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now smolvm
sudo systemctl status smolvm
```

## TLS with Caddy (recommended)

```bash
sudo apt install -y caddy

# /etc/caddy/Caddyfile
cat <<'EOF' | sudo tee /etc/caddy/Caddyfile
smolvm.your-domain.com {
    reverse_proxy 127.0.0.1:8080
}
EOF

sudo systemctl restart caddy
```

This gives you automatic HTTPS via Let's Encrypt. smolvm binds to localhost only; Caddy handles TLS termination.

## Firewall

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (Caddy redirect)
sudo ufw allow 443/tcp   # HTTPS (Caddy)
sudo ufw enable
```

Do NOT expose port 8080 directly — always go through the reverse proxy.

## Connect from local machine

```bash
# Direct
SMOLVM_URL=https://smolvm.your-domain.com SMOLVM_API_TOKEN=your-secret-token-here smolctl ls

# Or configure a provider
mkdir -p ~/.smolvm
cat > ~/.smolvm/providers.json <<'EOF'
{
  "providers": [
    {"name": "local", "url": "http://127.0.0.1:8080", "default": true},
    {"name": "cloud", "url": "https://smolvm.your-domain.com", "token": "your-secret-token-here"}
  ]
}
EOF

# Use it
smolctl --provider cloud ls
smolctl --provider cloud snapshot upload my-snapshot
smolctl --provider cloud snapshot download my-snapshot
```

## Verify

```bash
# On the server
curl -s http://127.0.0.1:8080/health | jq

# From your machine
smolctl --provider cloud health
```

## Workflow: Continue Claude Code on the go

```bash
# At home: push snapshot, upload to cloud
smolctl snapshot push my-vm --desc "WIP: feature branch"
smolctl --provider cloud snapshot upload my-vm

# On the go: download on cloud server, boot, work
smolctl --provider cloud snapshot pull my-vm remote-vm
smolctl --provider cloud up remote-vm

# Back home: download, merge
smolctl --provider cloud snapshot push remote-vm --desc "continued work"
smolctl snapshot download remote-vm   # from cloud provider
smolctl snapshot merge remote-vm my-vm
```
