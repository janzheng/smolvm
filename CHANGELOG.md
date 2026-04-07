# Changelog

All notable changes to smolvm are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Linux aarch64 binary support — libkrun + libkrunfw built on DGX Spark, committed via Git LFS
- linux-aarch64 build target in CI release workflow (cross-compilation via gcc-aarch64-linux-gnu)
- Comprehensive audit fix test suite (38 tests covering resources, timeouts, cloning, snapshots, adversarial edge cases)
- Snapshot push/pull now preserves full machine config (resources, secrets, MCP servers, allowed domains)
- CIDR-based egress filtering (VMM-level via libkrun)
- Hostname-based DNS filtering (vsock DNS proxy)
- SSH agent forwarding into VMs
- Bearer token auth on serve (`--api-token` flag + `SMOLVM_API_TOKEN` env)
- Background exec with concurrent stdout/stderr drain
- Smolfile restart policies + healthchecks
- `--allow-cidr` and `--allow-host` flags on create command

### Changed
- Renamed "sandbox" to "machine" across entire stack (Rust server, SDK, CLI, tests, docs, MCP servers)
- Moved server code to repo root for 1:1 upstream merge compatibility
- SDK wire format now uses camelCase (`memoryMb`, `timeoutSecs`, `exitCode`) matching Rust API serde

### Fixed
- Resource limits silently ignored — SDK/CLI sent snake_case fields, Rust API expected camelCase
- Overlay disk write regression from upstream merge (virtiofs + overlayfs causes "Connection reset")
- libkrunfw networking regression — upstream's 14MB build broke all outbound VM networking
- Agent tmpfs mount ordering — tmpfs mounted before pivot_root was shadowed under /oldroot
- Config not persisted across server restart (VmRecord now stores all fields)
- Clone not preserving secrets, default_env, owner_token_hash, MCP servers from source
- Dynamic launcher context leak on egress policy error
- mem::forget(child) leak in background exec
- Shell quoting injection in merge file transfer
- Auth headers missing on uploadFile, uploadArchive, downloadArchive
- Storage disk ext4 geometry mismatch — added resize2fs recovery path
- `build-dist.sh` libkrunfw check now matches versioned `.so.5` files

## [v0.2.0] - 2026-04-05

### Added
- Upstream sync with smol-machines/smolvm v0.5.0 (19 commits merged)
- Transfer API chunked I/O for large files (fixes hangs on >48KB archives/files)
- Snapshot filesystem sync before disk read (prevents corrupted git objects)
- Sparse-aware snapshot push (SMOLSPARSE format — 140MB to 10KB archives)
- Remote snapshot transfer (upload/download between smolvm servers)
- Workspace export/import (lightweight git repo extraction)
- Docker interop (workspace to Dockerfile generation)
- Web dashboard with ghostty-web terminal
- Snapshot file access (ls-files, cp) without pull/start/cleanup
- Git-based VM workspace merging (clone-to-branch, three-way merge, fleet fanout/gather)
- Fleet orchestration (up/down/exec/ls)
- Secret proxy (vsock reverse proxy, env stripping)
- MCP server integration (filesystem, exec, git — 18 tools)
- Job queue API with retry + dead letter
- Session recording and replay
- Code signing and RBAC
- Structured event log

### Fixed
- Sandbox delete leaked 30GB disk files per VM
- Snapshot pull destroyed sparse files (17MB to 30GB per pull)
