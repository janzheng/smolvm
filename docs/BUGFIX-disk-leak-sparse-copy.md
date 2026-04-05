# Bugfix: Disk Leak + Sparse Copy in Snapshot Pull

**Date:** 2026-03-22
**Files changed:**
- `smolvm-plus/src/api/handlers/machines.rs` — machine delete cleanup
- `smolvm-plus/src/api/handlers/snapshots.rs` — sparse-aware extraction

## Problem

Two bugs combined to silently consume ~271 GB of disk:

### 1. Machine delete never cleaned up VM disk files

`DELETE /machines/{name}` removed the machine from the in-memory registry but
**never deleted the VM data directory** (`~/Library/Caches/smolvm/vms/{name}/`).
Every machine that was created and deleted left behind its `overlay.raw` +
`storage.raw` files permanently.

### 2. Snapshot pull destroyed sparse file optimization

`overlay.raw` and `storage.raw` are created as **sparse files** — they report
an apparent size of 10 GB + 20 GB but only consume actual disk for non-zero
blocks (~25–49 MB for a fresh machine).

However, `pull_snapshot` used `std::io::copy` to extract disk images from the
tar.gz archive. This writes every byte sequentially — including the vast zero
regions — producing **dense** files that consume their full apparent size on
disk.

**Result:** Each snapshot pull created ~30 GB of real disk usage instead of
~25 MB. Combined with bug #1 (never cleaning up), leaked machines accumulated
to hundreds of GB.

### Measured impact

| Scenario | Apparent size | Actual disk (before) | Actual disk (after) |
|---|---|---|---|
| Fresh `create` (always sparse) | 30 GB | 49 MB | 49 MB |
| Snapshot `pull` | 30 GB | **30 GB** | **17 MB** |

## Fix

### Machine delete cleanup (`machines.rs`)

Added `std::fs::remove_dir_all(vm_data_dir(&name))` to `delete_machine` after
stopping the VM process. This ensures `overlay.raw`, `storage.raw`, and all
marker files are removed when a machine is deleted.

### Sparse-aware copy (`snapshots.rs`)

Replaced `std::io::copy(&mut entry, &mut out)` with a new `sparse_copy()`
function that:

1. Reads input in 4 KB blocks
2. Detects all-zero blocks
3. **Seeks** over zero blocks instead of writing them (using `Seek::seek`)
4. Only writes non-zero blocks to disk
5. If the file ends with zeros, writes a single byte at the final position to
   set the correct file size

This preserves sparseness through the tar extraction pipeline. The 4 KB block
size matches the typical filesystem block size, so the resulting file is as
sparse as a freshly-created one.

### Why not use `SEEK_HOLE`/`SEEK_DATA`?

These syscalls let you detect sparse regions in an *existing* file, but the
problem is at *write* time during extraction from a streaming tar reader. We
never have the sparse file to read — we're creating it. The block-level zero
detection during copy is the correct approach here.

## Upstream applicability

Both fixes apply to upstream smolvm. The sparse copy function is portable
(uses only `std::io::Read`, `Write`, `Seek`) and has no platform-specific
dependencies. The delete cleanup is a straightforward missing `remove_dir_all`.

## Testing

Verified with a push → pull round-trip:
- Fresh create: 49 MB actual (unchanged)
- Snapshot pull: 17 MB actual (was 30 GB)
- Machine delete: directory fully removed (was leaked)
