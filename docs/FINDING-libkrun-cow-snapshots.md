# Finding: libkrun COW Architecture and Snapshot Limitations

**Date:** 2026-03-22

## Discovery

While implementing incremental snapshots (block-level delta between parent and
child disk images), we discovered that **overlay.raw and storage.raw never
change from the host's perspective while the VM is running or after it stops**.

All VM writes go to libkrun's internal copy-on-write layer which is invisible
to the host filesystem. The host disk files are immutable bases.

## Evidence

1. Created fresh sandbox, pushed snapshot (v1)
2. Installed vim (31 MB of new packages), wrote marker file, ran `sync`
3. Stopped VM to ensure flush
4. MD5 of overlay.raw: **identical** before and after
5. MD5 of storage.raw: **identical** before and after
6. Yet: marker file and vim **survive push/pull/boot cycle**

## What This Means

### For existing full snapshots
Full snapshots archive the immutable base disk files. These are identical across
all sandboxes created from the same OCI image. **Live VM state (installed
packages, written files) is stored in libkrun's COW layer, NOT in the host
disk files.**

Snapshots "work" because pulled sandboxes boot from the same base overlay,
which already contains init_commands effects (packages installed at creation
time). But **modifications made after creation (runtime installs, file writes)
are NOT captured in snapshot archives**.

### For incremental snapshots
Block-level delta between parent and child overlay.raw always shows 0 changed
blocks, because the file never changes. The delta infrastructure is correct
but produces trivially small deltas (just the manifest).

### For the storage disk (/dev/vda)
Storage.raw is formatted and mounted as /dev/vda inside the VM. It's used for
/storage/workspace. Like overlay.raw, it appears immutable from the host. Git
data in /storage/workspace that survives push/pull may be written during
init_commands (at creation) rather than during runtime.

## Impact Assessment

| Feature | Status | Impact |
|---|---|---|
| Full snapshot push/pull | Works | Archives base state, not live state |
| Incremental delta | Technically works | Always 0 changes (base is immutable) |
| Snapshot history/rollback | Works | Useful for versioning creation configs |
| Data persistence | Partial | Only init_commands effects persist through snapshots |

## Workarounds

1. **Workspace export/import** (`smolctl snapshot export-workspace`) — uses
   `exec tar` inside the VM to capture live workspace state. This works because
   it reads from the guest filesystem (which includes COW changes), not the
   host disk file.

2. **Different init_commands** — to capture different states, create different
   sandboxes with different init_commands rather than snapshotting live state.

## Upstream Fix Needed

libkrun would need to either:
1. Expose a "flush COW to disk" API that writes dirty blocks back to the host file
2. Provide a "snapshot" API that captures the COW diff
3. Use write-through (not COW) for disk images

This is filed as an upstream limitation alongside TSI issues.

## Files Changed

The incremental snapshot infrastructure is still shipped and will work once
libkrun exposes COW state:

- `smolvm-plus/src/api/types.rs` — new manifest fields
- `smolvm-plus/src/api/handlers/delta.rs` — delta module (new)
- `smolvm-plus/src/api/handlers/snapshots.rs` — versioned push/pull, history, rollback
- `smolvm-plus/src/api/mod.rs` — route registration
