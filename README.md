# smolvm

Local microVMs. Hardware isolation. Single binary.

> **Alpha** — APIs can change. [Report issues](https://github.com/smol-machines/smolvm/issues)

## install

Download from [GitHub Releases](https://github.com/smol-machines/smolvm/releases), or:

```bash
curl -sSL https://smolmachines.com/install.sh | bash
```

## usage

```bash
# sandbox — ephemeral isolated environments
smolvm sandbox run --net alpine -- echo "hello"
smolvm sandbox run --net python:3.12-alpine -- python -V
smolvm sandbox run --net -v ./src:/workspace alpine -- ls /workspace  # explicit mount

# microvm — persistent Linux VMs
smolvm microvm create --net myvm
smolvm microvm start myvm
smolvm microvm exec --name myvm -- apk add git
smolvm microvm exec --name myvm -it -- /bin/sh
smolvm microvm stop myvm

# smolfile — declarative VM configuration
smolvm sandbox run -d -s my-app.smolfile alpine
smolvm microvm create myvm -s my-app.smolfile

# pack — portable, executable virtual machine
smolvm pack create alpine -o ./my-sandbox
./my-sandbox echo "hello"
```

## about

smolvm runs Linux microVMs on your machine. No daemon, no Docker, no cloud account.

A microVM is a lightweight VM — hardware-level isolation with <200ms boot. Your host filesystem, network, and credentials are separated from the workload unless explicitly shared.

## comparison

|                     | Containers | Colima + krunkit | QEMU | Firecracker | Kata | smolvm |
|---------------------|------------|-----------------|------|-------------|------|--------|
| isolation           | namespace (shared kernel) [\[1\]](#references) | namespace (inside 1 VM) | separate VM | separate VM | VM per container [\[2\]](#references) | VM per workload |
| boot time           | ~100ms [\[3\]](#references) | ~seconds (1 VM) | ~15-30s [\[4\]](#references) | <125ms [\[5\]](#references) | ~500ms [\[6\]](#references) | <200ms |
| architecture        | daemon | daemon (containerd in VM) | process | process | runtime stack [\[7\]](#references) | library (libkrun) |
| per-workload VMs    | no | no (shared VM) | yes | yes | yes | yes |
| macOS               | via Docker VM | yes (krunkit) | yes | no [\[8\]](#references) | no [\[9\]](#references) | yes |
| embeddable (SDK)    | no | no | no | no | no | yes |
| portable artifacts  | images (need daemon) | no | no | no | no | `.smolmachine` |

<details>
<summary id="references">References</summary>

1. [Container isolation](https://www.docker.com/blog/understanding-docker-container-escapes/)
2. [Kata Containers](https://katacontainers.io/)
3. [containerd benchmark](https://github.com/containerd/containerd/issues/4482)
4. [QEMU boot time](https://wiki.qemu.org/Features/TCG)
5. [Firecracker website](https://firecracker-microvm.github.io/)
6. [Kata boot time](https://github.com/kata-containers/kata-containers/issues/4292)
7. [Kata installation](https://github.com/kata-containers/kata-containers/blob/main/docs/install/README.md)
8. [Firecracker requires KVM](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md)
9. [Kata macOS support](https://github.com/kata-containers/kata-containers/issues/243)

</details>

## how it works

[libkrun](https://github.com/containers/libkrun) VMM + Hypervisor.framework (macOS) / KVM (Linux) + crun container runtime. No daemon — the VMM is a library.

Custom kernel: [libkrunfw](https://github.com/smol-machines/libkrunfw)

## platform support

| host | guest | requirements |
|------|-------|--------------|
| macOS Apple Silicon | arm64 Linux | macOS 11+ |
| macOS Intel | x86_64 Linux | macOS 11+ (untested) |
| Linux x86_64 | x86_64 Linux | KVM (`/dev/kvm`) |
| Linux aarch64 | aarch64 Linux | KVM (`/dev/kvm`) |

## known limitations

- **Network is opt-in for sandboxes**: `--net` enables outbound networking for `sandbox run` and `sandbox create`. The default microVM (`smolvm microvm start`) has networking enabled for ease of use. TCP/UDP only — no ICMP.
- **Volume mounts**: Directories only (no single files)
- **macOS**: Binary must be signed with Hypervisor.framework entitlements

## development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## license

Apache-2.0
