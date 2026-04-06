//! Snapshot push/pull handlers.
//!
//! Provides endpoints for exporting machine state as compressed archives
//! (push) and importing them into new machines (pull).

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use std::sync::Arc;
use tokio_util::io::ReaderStream;

use crate::agent::{vm_data_dir, AgentManager};
use crate::api::error::ApiError;
use crate::api::state::{ApiState, ReservationGuard, MachineRegistration};
use crate::api::types::{
    ApiErrorResponse, ListSnapshotsResponse, PullSnapshotRequest, PushSnapshotRequest,
    PushSnapshotResponse, ResourceSpec, RollbackRequest, RollbackResponse, MachineInfo,
    SnapshotHistoryResponse, SnapshotManifest, UploadSnapshotQuery, UploadSnapshotResponse,
};
use crate::storage::{
    OverlayDisk, StorageDisk, OVERLAY_DISK_FILENAME, STORAGE_DISK_FILENAME,
};

/// Copy from reader to writer, preserving sparseness by seeking over zero blocks.
/// Without this, extracting disk images from tar archives writes every zero byte,
/// turning a 49MB sparse file into a 30GB dense file.
fn sparse_copy<R: std::io::Read, W: std::io::Write + std::io::Seek>(
    reader: &mut R,
    writer: &mut W,
) -> std::io::Result<u64> {
    const BLOCK_SIZE: usize = 4096;
    let zero_block = [0u8; BLOCK_SIZE];
    let mut buf = [0u8; BLOCK_SIZE];
    let mut total: u64 = 0;
    let mut pending_seek: u64 = 0;

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            // If the file ends with zeros, extend to final size
            if pending_seek > 0 {
                writer.seek(std::io::SeekFrom::Current(pending_seek as i64 - 1))?;
                writer.write_all(&[0])?;
            }
            break;
        }

        if buf[..n] == zero_block[..n] {
            // Zero block — accumulate seek offset instead of writing
            pending_seek += n as u64;
        } else {
            // Non-zero block — apply any pending seek, then write
            if pending_seek > 0 {
                writer.seek(std::io::SeekFrom::Current(pending_seek as i64))?;
                pending_seek = 0;
            }
            writer.write_all(&buf[..n])?;
        }
        total += n as u64;
    }
    Ok(total)
}

/// Sparse image format (.sparse suffix in tar):
///   Header: "SMOLSPARSE\x01" (11 bytes magic + version)
///   u64 LE: apparent_size
///   u32 LE: block_size (4096)
///   u32 LE: num_blocks (number of non-zero blocks)
///   For each block:
///     u64 LE: offset
///     [block_size bytes]: data
///
/// This format stores only non-zero 4K blocks, skipping the vast majority
/// of a sparse disk image. A 20GB disk with 49MB actual data produces ~49MB
/// of sparse image data (vs 140MB gzipped full image).
const SPARSE_MAGIC: &[u8; 11] = b"SMOLSPARSE\x01";
const SPARSE_BLOCK_SIZE: usize = 4096;

/// Append a disk image to a tar archive in sparse format, skipping zero blocks.
/// Instead of writing the full 20GB apparent file, this scans for non-zero 4K blocks
/// and writes only those with their offsets. Combined with gzip, this dramatically
/// reduces archive size.
fn append_sparse_file<W: std::io::Write>(
    tar: &mut tar::Builder<W>,
    disk_path: &std::path::Path,
    archive_name: &str,
) -> std::io::Result<()> {
    let zero_block = [0u8; SPARSE_BLOCK_SIZE];
    let mut file = std::fs::File::open(disk_path)?;
    let apparent_size = file.metadata()?.len();

    // Scan for non-zero blocks
    let mut blocks: Vec<(u64, Vec<u8>)> = Vec::new();
    let mut buf = [0u8; SPARSE_BLOCK_SIZE];
    let mut offset: u64 = 0;

    loop {
        let n = std::io::Read::read(&mut file, &mut buf)?;
        if n == 0 {
            break;
        }
        if buf[..n] != zero_block[..n] {
            blocks.push((offset, buf[..n].to_vec()));
        }
        offset += n as u64;
    }

    // Build sparse image in memory
    // Header: magic(11) + apparent_size(8) + block_size(4) + num_blocks(4) = 27 bytes
    // Per block: offset(8) + data(4096) = 4104 bytes
    let num_blocks = blocks.len() as u32;
    let sparse_size = 27 + (blocks.len() as u64) * (8 + SPARSE_BLOCK_SIZE as u64);

    let mut sparse_data = Vec::with_capacity(sparse_size as usize);
    sparse_data.extend_from_slice(SPARSE_MAGIC);
    sparse_data.extend_from_slice(&apparent_size.to_le_bytes());
    sparse_data.extend_from_slice(&(SPARSE_BLOCK_SIZE as u32).to_le_bytes());
    sparse_data.extend_from_slice(&num_blocks.to_le_bytes());

    for (off, data) in &blocks {
        sparse_data.extend_from_slice(&off.to_le_bytes());
        sparse_data.extend_from_slice(data);
    }

    // Write as tar entry with .sparse suffix
    let sparse_name = format!("{}.sparse", archive_name);
    let mut header = tar::Header::new_gnu();
    header.set_size(sparse_data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, &sparse_name, &sparse_data[..])?;

    Ok(())
}

/// Reconstruct a full sparse file from the sparse image format.
/// Reads the .sparse format and writes a sparse file using seeks over zero regions.
fn extract_sparse_file<W: std::io::Write + std::io::Seek>(
    sparse_data: &[u8],
    writer: &mut W,
) -> std::io::Result<()> {
    if sparse_data.len() < 27 || &sparse_data[..11] != SPARSE_MAGIC {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid sparse image magic",
        ));
    }

    let apparent_size = u64::from_le_bytes(sparse_data[11..19].try_into().unwrap());
    let _block_size = u32::from_le_bytes(sparse_data[19..23].try_into().unwrap()) as usize;
    let num_blocks = u32::from_le_bytes(sparse_data[23..27].try_into().unwrap()) as usize;

    let mut pos = 27;
    for _ in 0..num_blocks {
        if pos + 8 + SPARSE_BLOCK_SIZE > sparse_data.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "truncated sparse image",
            ));
        }
        let offset = u64::from_le_bytes(sparse_data[pos..pos + 8].try_into().unwrap());
        let data = &sparse_data[pos + 8..pos + 8 + SPARSE_BLOCK_SIZE];
        writer.seek(std::io::SeekFrom::Start(offset))?;
        writer.write_all(data)?;
        pos += 8 + SPARSE_BLOCK_SIZE;
    }

    // Ensure file is the correct apparent size (extend if last block is before EOF)
    if apparent_size > 0 {
        writer.seek(std::io::SeekFrom::Start(apparent_size - 1))?;
        writer.write_all(&[0])?;
    }

    Ok(())
}

/// Directory where snapshots are stored.
fn snapshots_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("smolvm")
        .join("snapshots")
}

/// Scan for existing versioned archives and return the next sequence number.
fn next_sequence(snap_dir: &std::path::Path, name: &str) -> u32 {
    let prefix = format!("{}.v", name);
    let mut max_seq: u32 = 0;
    if let Ok(entries) = std::fs::read_dir(snap_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name();
            let fname = fname.to_string_lossy();
            if let Some(rest) = fname.strip_prefix(&prefix) {
                if let Some(seq_str) = rest.strip_suffix(".smolvm") {
                    if let Ok(seq) = seq_str.parse::<u32>() {
                        max_seq = max_seq.max(seq);
                    }
                }
            }
        }
    }
    max_seq + 1
}

/// Find the latest versioned archive for a snapshot name.
/// Returns the highest-sequence versioned file, or falls back to {name}.smolvm.
fn find_latest_archive(snap_dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let prefix = format!("{}.v", name);
    let mut best: Option<(u32, std::path::PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(snap_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name();
            let fname_str = fname.to_string_lossy();
            if let Some(rest) = fname_str.strip_prefix(&prefix) {
                if let Some(seq_str) = rest.strip_suffix(".smolvm") {
                    if let Ok(seq) = seq_str.parse::<u32>() {
                        if best.as_ref().is_none_or(|(s, _)| seq > *s) {
                            best = Some((seq, entry.path()));
                        }
                    }
                }
            }
        }
    }
    best.map(|(_, p)| p).or_else(|| {
        let legacy = snap_dir.join(format!("{}.smolvm", name));
        if legacy.exists() { Some(legacy) } else { None }
    })
}

/// Find the latest full (version 1) archive for a snapshot name.
/// Used for incremental delta comparison — we need full disk images to diff against.
fn find_latest_full_archive(snap_dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let prefix = format!("{}.v", name);
    let mut best: Option<(u32, std::path::PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(snap_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name();
            let fname_str = fname.to_string_lossy();
            if let Some(rest) = fname_str.strip_prefix(&prefix) {
                if let Some(seq_str) = rest.strip_suffix(".smolvm") {
                    if let Ok(seq) = seq_str.parse::<u32>() {
                        // Check if this is a full archive (version 1)
                        if let Ok(manifest) = read_manifest_from_archive(&entry.path()) {
                            if manifest.snapshot_version <= 1
                                && best.as_ref().is_none_or(|(s, _)| seq > *s) {
                                    best = Some((seq, entry.path()));
                                }
                        }
                    }
                }
            }
        }
    }
    best.map(|(_, p)| p).or_else(|| {
        // Fall back to legacy {name}.smolvm if it exists and is full
        let legacy = snap_dir.join(format!("{}.smolvm", name));
        if legacy.exists() {
            if let Ok(m) = read_manifest_from_archive(&legacy) {
                if m.snapshot_version <= 1 {
                    return Some(legacy);
                }
            }
        }
        None
    })
}

/// Walk the delta chain to find its depth (number of incremental snapshots until a full one).
fn chain_depth(snap_dir: &std::path::Path, archive_path: &std::path::Path) -> usize {
    let mut depth = 0;
    let mut current = archive_path.to_path_buf();
    for _ in 0..20 {
        // Safety limit
        if let Ok(manifest) = read_manifest_from_archive(&current) {
            if manifest.snapshot_version <= 1 {
                break; // Found a full snapshot — end of chain
            }
            depth += 1;
            // Find the parent archive
            if let Some(parent_name) = &manifest.parent_snapshot {
                if let Some(parent_path) = find_latest_archive(snap_dir, parent_name) {
                    current = parent_path;
                    continue;
                }
            }
            break; // Parent not found
        } else {
            break;
        }
    }
    depth
}

/// Helper to exec a command in a running machine and return trimmed stdout.
/// Returns None if the machine is not running or the command fails.
async fn try_exec_in_machine(
    entry: &Arc<parking_lot::Mutex<crate::api::state::MachineEntry>>,
    command: Vec<String>,
) -> Option<String> {
    use crate::api::state::with_machine_client;
    let result = with_machine_client(entry, move |c| {
        c.vm_exec(command, vec![], None, Some(std::time::Duration::from_secs(5)))
    })
    .await;
    match result {
        Ok((0, stdout, _)) => Some(stdout.trim().to_string()),
        _ => None,
    }
}

/// Push (export) a machine as a snapshot archive.
#[utoipa::path(
    post,
    path = "/api/v1/machines/{id}/push",
    tag = "Machinees",
    params(
        ("id" = String, Path, description = "Machine name to export")
    ),
    request_body(content = Option<PushSnapshotRequest>, description = "Optional push metadata"),
    responses(
        (status = 200, description = "Snapshot created", body = PushSnapshotResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse),
        (status = 500, description = "Export failed", body = ApiErrorResponse)
    )
)]
pub async fn push_machine(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    body: Option<Json<PushSnapshotRequest>>,
) -> Result<Json<PushSnapshotResponse>, ApiError> {
    let req = body.map(|b| b.0).unwrap_or_default();

    // Verify machine exists
    let entry = state.get_machine(&id)?;

    let network = {
        let lock = entry.lock();
        lock.network
    };

    // Get disk paths
    let data_dir = vm_data_dir(&id);
    let overlay_path = data_dir.join(OVERLAY_DISK_FILENAME);
    let storage_path = data_dir.join(STORAGE_DISK_FILENAME);

    if !overlay_path.exists() && !storage_path.exists() {
        return Err(ApiError::BadRequest(
            "machine has no disk state to export".into(),
        ));
    }

    // Flush filesystem caches so disk images are consistent for snapshot.
    // 1. Guest-side sync: flush FS caches to guest block device
    let _ = try_exec_in_machine(
        &entry,
        vec!["sync".into()],
    ).await;
    // 2. Guest-side: explicitly flush the storage block device
    let _ = try_exec_in_machine(
        &entry,
        vec!["sh".into(), "-c".into(), "blockdev --flushbufs /dev/vda 2>/dev/null; sync".into()],
    ).await;
    // 3. Host-side: fsync the disk image files to ensure virtio-blk writes
    //    have been flushed through to the host filesystem
    if storage_path.exists() {
        if let Ok(f) = std::fs::File::open(&storage_path) {
            let _ = f.sync_all();
        }
    }
    if overlay_path.exists() {
        if let Ok(f) = std::fs::File::open(&overlay_path) {
            let _ = f.sync_all();
        }
    }

    // Capture git info (best-effort — works only if machine is running with git workspace)
    let git_branch = try_exec_in_machine(
        &entry,
        vec!["sh".into(), "-c".into(), "git -C /storage/workspace rev-parse --abbrev-ref HEAD 2>/dev/null || git -C /workspace rev-parse --abbrev-ref HEAD 2>/dev/null".into()],
    ).await;
    let git_commit = try_exec_in_machine(
        &entry,
        vec!["sh".into(), "-c".into(), "git -C /storage/workspace rev-parse HEAD 2>/dev/null || git -C /workspace rev-parse HEAD 2>/dev/null".into()],
    ).await;
    let git_dirty = try_exec_in_machine(
        &entry,
        vec!["sh".into(), "-c".into(), "git -C /storage/workspace status --porcelain 2>/dev/null || git -C /workspace status --porcelain 2>/dev/null".into()],
    ).await.map(|s| !s.is_empty());

    // Read .smolvm_origin for automatic parent tracking
    let auto_parent = if req.parent_snapshot.is_none() {
        let origin_path = data_dir.join(".smolvm_origin");
        std::fs::read_to_string(&origin_path).ok().map(|s| s.trim().to_string())
    } else {
        None
    };

    // Create snapshots directory
    let snap_dir = snapshots_dir();
    std::fs::create_dir_all(&snap_dir)
        .map_err(|e| ApiError::Internal(format!("failed to create snapshots dir: {}", e)))?;

    let snapshot_name = id.clone();

    // Determine sequence number by scanning existing versioned archives
    let sequence = next_sequence(&snap_dir, &snapshot_name);

    // Versioned archive: {name}.v{N}.smolvm, plus {name}.smolvm as latest
    let versioned_path = snap_dir.join(format!("{}.v{}.smolvm", snapshot_name, sequence));
    let archive_path = snap_dir.join(format!("{}.smolvm", snapshot_name));

    // Build manifest
    let overlay_size = if overlay_path.exists() {
        std::fs::metadata(&overlay_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    let storage_size = if storage_path.exists() {
        std::fs::metadata(&storage_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    let platform = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };

    let parent_snapshot_name = req.parent_snapshot.or(auto_parent);
    let incremental_requested = req.incremental.unwrap_or(false);

    // Check if we can do incremental: need parent archive with full disk images locally.
    // For delta comparison, we need a full (version 1) archive to extract base disks from.
    let parent_archive = parent_snapshot_name.as_ref().and_then(|parent_name| {
        if !incremental_requested {
            return None;
        }
        find_latest_full_archive(&snap_dir, parent_name)
    });

    // Check delta chain depth — auto-consolidate if > 5
    let force_full = parent_archive.as_ref().is_some_and(|parent_path| {
        chain_depth(&snap_dir, parent_path) >= 5
    });

    let do_incremental = parent_archive.is_some() && !force_full;

    // Read parent SHA-256 if doing incremental
    let parent_sha256_val = if do_incremental {
        parent_archive.as_ref().and_then(|p| {
            let sidecar = format!("{}.sha256", p.display());
            std::fs::read_to_string(&sidecar).ok().map(|s| s.trim().to_string())
        })
    } else {
        None
    };

    // Build base manifest (will be updated with delta info if incremental succeeds)
    let mut manifest = SnapshotManifest {
        name: snapshot_name.clone(),
        platform: format!("{}-{}", platform, os),
        network,
        created_at: chrono::Utc::now().to_rfc3339(),
        overlay_size_bytes: overlay_size,
        storage_size_bytes: storage_size,
        description: req.description,
        owner: None,
        parent_snapshot: parent_snapshot_name,
        git_branch,
        git_commit,
        git_dirty,
        sha256: None,
        snapshot_version: 1,
        parent_sha256: None,
        block_size: None,
        overlay_changed_blocks: None,
        storage_changed_blocks: None,
        sequence: Some(sequence),
    };

    // Create tar.gz archive in a blocking task
    let versioned_path_clone = versioned_path.clone();
    let manifest_for_archive = manifest.clone();
    let parent_archive_clone = parent_archive.clone();

    let incremental_result = tokio::task::spawn_blocking(move || {
        use flate2::write::GzEncoder;
        use flate2::Compression;

        if do_incremental {
            if let Some(ref parent_path) = parent_archive_clone {
                // Try incremental: extract parent disks to temp, compute delta
                let temp_dir = tempfile::tempdir()
                    .map_err(|e| ApiError::Internal(format!("failed to create temp dir: {}", e)))?;

                let mut overlay_delta = None;
                let mut storage_delta = None;

                // Compute overlay delta
                if overlay_path.exists() {
                    let parent_overlay = temp_dir.path().join(OVERLAY_DISK_FILENAME);
                    if super::delta::extract_file_from_archive(
                        parent_path,
                        OVERLAY_DISK_FILENAME,
                        &parent_overlay,
                    ).is_ok() {
                        if let Ok(delta) = super::delta::compute_delta(&parent_overlay, &overlay_path) {
                            overlay_delta = Some(delta);
                        }
                    }
                }

                // Compute storage delta
                if storage_path.exists() {
                    let parent_storage = temp_dir.path().join(STORAGE_DISK_FILENAME);
                    if super::delta::extract_file_from_archive(
                        parent_path,
                        STORAGE_DISK_FILENAME,
                        &parent_storage,
                    ).is_ok() {
                        if let Ok(delta) = super::delta::compute_delta(&parent_storage, &storage_path) {
                            storage_delta = Some(delta);
                        }
                    }
                }

                // Check if delta is worthwhile (< 80% of full size)
                let full_size = overlay_size + storage_size;
                let delta_size = overlay_delta.as_ref().map_or(overlay_size, |d| d.delta_size())
                    + storage_delta.as_ref().map_or(storage_size, |d| d.delta_size());

                if full_size > 0 && delta_size < full_size * 80 / 100 {
                    // Write incremental archive
                    let mut m = manifest_for_archive;
                    m.snapshot_version = 2;
                    m.parent_sha256 = parent_sha256_val;
                    m.block_size = Some(super::delta::DELTA_BLOCK_SIZE as u32);
                    m.overlay_changed_blocks = overlay_delta.as_ref().map(|d| d.num_changed());
                    m.storage_changed_blocks = storage_delta.as_ref().map(|d| d.num_changed());

                    let file = std::fs::File::create(&versioned_path_clone)
                        .map_err(|e| ApiError::Internal(format!("failed to create archive: {}", e)))?;
                    let enc = GzEncoder::new(file, Compression::fast());
                    let mut tar = tar::Builder::new(enc);

                    // Write manifest
                    let manifest_json = serde_json::to_vec_pretty(&m)
                        .map_err(|e| ApiError::Internal(format!("failed to serialize manifest: {}", e)))?;
                    let mut header = tar::Header::new_gnu();
                    header.set_size(manifest_json.len() as u64);
                    header.set_mode(0o644);
                    header.set_cksum();
                    tar.append_data(&mut header, "manifest.json", &manifest_json[..])
                        .map_err(|e| ApiError::Internal(format!("failed to write manifest: {}", e)))?;

                    // Write overlay delta
                    if let Some(ref delta) = overlay_delta {
                        let mut delta_buf = Vec::new();
                        super::delta::write_delta(delta, &mut delta_buf)
                            .map_err(|e| ApiError::Internal(format!("failed to write overlay delta: {}", e)))?;
                        let mut header = tar::Header::new_gnu();
                        header.set_size(delta_buf.len() as u64);
                        header.set_mode(0o644);
                        header.set_cksum();
                        tar.append_data(&mut header, "overlay.delta", &delta_buf[..])
                            .map_err(|e| ApiError::Internal(format!("failed to add overlay delta: {}", e)))?;
                    }

                    // Write storage delta
                    if let Some(ref delta) = storage_delta {
                        let mut delta_buf = Vec::new();
                        super::delta::write_delta(delta, &mut delta_buf)
                            .map_err(|e| ApiError::Internal(format!("failed to write storage delta: {}", e)))?;
                        let mut header = tar::Header::new_gnu();
                        header.set_size(delta_buf.len() as u64);
                        header.set_mode(0o644);
                        header.set_cksum();
                        tar.append_data(&mut header, "storage.delta", &delta_buf[..])
                            .map_err(|e| ApiError::Internal(format!("failed to add storage delta: {}", e)))?;
                    }

                    tar.into_inner()
                        .map_err(|e| ApiError::Internal(format!("failed to finalize gz: {}", e)))?
                        .finish()
                        .map_err(|e| ApiError::Internal(format!("failed to finish gz: {}", e)))?;

                    return Ok(Some(m));
                }
            }
        }

        // Full snapshot (default path, or incremental fallback)
        let file = std::fs::File::create(&versioned_path_clone)
            .map_err(|e| ApiError::Internal(format!("failed to create archive: {}", e)))?;
        let enc = GzEncoder::new(file, Compression::fast());
        let mut tar = tar::Builder::new(enc);

        let manifest_json = serde_json::to_vec_pretty(&manifest_for_archive)
            .map_err(|e| ApiError::Internal(format!("failed to serialize manifest: {}", e)))?;
        let mut header = tar::Header::new_gnu();
        header.set_size(manifest_json.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, "manifest.json", &manifest_json[..])
            .map_err(|e| ApiError::Internal(format!("failed to write manifest to tar: {}", e)))?;

        if overlay_path.exists() {
            append_sparse_file(&mut tar, &overlay_path, OVERLAY_DISK_FILENAME)
                .map_err(|e| ApiError::Internal(format!("failed to add overlay to archive: {}", e)))?;
        }
        if storage_path.exists() {
            append_sparse_file(&mut tar, &storage_path, STORAGE_DISK_FILENAME)
                .map_err(|e| ApiError::Internal(format!("failed to add storage to archive: {}", e)))?;
        }

        tar.into_inner()
            .map_err(|e| ApiError::Internal(format!("failed to finalize gz: {}", e)))?
            .finish()
            .map_err(|e| ApiError::Internal(format!("failed to finish gz: {}", e)))?;

        Ok::<Option<SnapshotManifest>, ApiError>(None)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    // If incremental succeeded, update manifest
    if let Some(incremental_manifest) = incremental_result {
        manifest = incremental_manifest;
    }

    // Copy versioned archive as the "latest" symlink
    let _ = std::fs::copy(&versioned_path, &archive_path);

    // Compute SHA-256 of the versioned archive and write sidecar files
    let versioned_for_hash = versioned_path.clone();
    let archive_for_hash = archive_path.clone();
    let sha256 = tokio::task::spawn_blocking(move || {
        use sha2::{Sha256, Digest};
        let mut file = std::fs::File::open(&versioned_for_hash)
            .map_err(|e| ApiError::Internal(format!("failed to open archive for hashing: {}", e)))?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher)
            .map_err(|e| ApiError::Internal(format!("failed to hash archive: {}", e)))?;
        let hash = format!("{:x}", hasher.finalize());
        // Write sidecar .sha256 for both versioned and latest
        let _ = std::fs::write(format!("{}.sha256", versioned_for_hash.display()), &hash);
        let _ = std::fs::write(format!("{}.sha256", archive_for_hash.display()), &hash);
        Ok::<String, ApiError>(hash)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    manifest.sha256 = Some(sha256);

    Ok(Json(PushSnapshotResponse {
        name: snapshot_name,
        path: versioned_path.display().to_string(),
        manifest,
    }))
}

/// List available snapshots.
#[utoipa::path(
    get,
    path = "/api/v1/snapshots",
    tag = "Machinees",
    responses(
        (status = 200, description = "List of snapshots", body = ListSnapshotsResponse)
    )
)]
pub async fn list_snapshots() -> Result<Json<ListSnapshotsResponse>, ApiError> {
    let snap_dir = snapshots_dir();
    if !snap_dir.exists() {
        return Ok(Json(ListSnapshotsResponse {
            snapshots: vec![],
        }));
    }

    let mut snapshots = Vec::new();

    let entries = std::fs::read_dir(&snap_dir)
        .map_err(|e| ApiError::Internal(format!("failed to read snapshots dir: {}", e)))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let filename = path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or_default();
        // Accept both new .smolvm and legacy .smolvm.tar.gz
        if !filename.ends_with(".smolvm") && !filename.ends_with(".smolvm.tar.gz") {
            continue;
        }

        // Try to read manifest from archive
        if let Ok(mut manifest) = read_manifest_from_archive(&path) {
            // Read SHA-256 from sidecar file if not already in manifest
            if manifest.sha256.is_none() {
                let sidecar = format!("{}.sha256", path.display());
                if let Ok(hash) = std::fs::read_to_string(&sidecar) {
                    manifest.sha256 = Some(hash.trim().to_string());
                }
            }
            snapshots.push(manifest);
        }
    }

    Ok(Json(ListSnapshotsResponse { snapshots }))
}

/// Extract a full (version 1) snapshot archive to a target directory.
fn extract_full_archive(
    archive_path: &std::path::Path,
    target_dir: &std::path::Path,
) -> Result<(), ApiError> {
    use flate2::read::GzDecoder;

    let file = std::fs::File::open(archive_path)
        .map_err(|e| ApiError::Internal(format!("failed to open archive: {}", e)))?;
    let dec = GzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);

    for entry in tar
        .entries()
        .map_err(|e| ApiError::Internal(format!("failed to read tar entries: {}", e)))?
    {
        let mut entry = entry
            .map_err(|e| ApiError::Internal(format!("failed to read tar entry: {}", e)))?;
        let path = entry
            .path()
            .map_err(|e| ApiError::Internal(format!("failed to read entry path: {}", e)))?
            .to_path_buf();

        let filename = path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or_default();

        match filename {
            // New sparse format: overlay.raw.sparse / storage.raw.sparse
            name if name == format!("{}.sparse", OVERLAY_DISK_FILENAME) => {
                let dest = target_dir.join(OVERLAY_DISK_FILENAME);
                let mut sparse_data = Vec::new();
                std::io::Read::read_to_end(&mut entry, &mut sparse_data).map_err(|e| {
                    ApiError::Internal(format!("failed to read sparse overlay: {}", e))
                })?;
                let mut out = std::fs::File::create(&dest).map_err(|e| {
                    ApiError::Internal(format!("failed to create overlay file: {}", e))
                })?;
                extract_sparse_file(&sparse_data, &mut out).map_err(|e| {
                    ApiError::Internal(format!("failed to extract sparse overlay: {}", e))
                })?;
            }
            name if name == format!("{}.sparse", STORAGE_DISK_FILENAME) => {
                let dest = target_dir.join(STORAGE_DISK_FILENAME);
                let mut sparse_data = Vec::new();
                std::io::Read::read_to_end(&mut entry, &mut sparse_data).map_err(|e| {
                    ApiError::Internal(format!("failed to read sparse storage: {}", e))
                })?;
                let mut out = std::fs::File::create(&dest).map_err(|e| {
                    ApiError::Internal(format!("failed to create storage file: {}", e))
                })?;
                extract_sparse_file(&sparse_data, &mut out).map_err(|e| {
                    ApiError::Internal(format!("failed to extract sparse storage: {}", e))
                })?;
            }
            // Legacy full format: overlay.raw / storage.raw
            name if name == OVERLAY_DISK_FILENAME => {
                let dest = target_dir.join(OVERLAY_DISK_FILENAME);
                let mut out = std::fs::File::create(&dest).map_err(|e| {
                    ApiError::Internal(format!("failed to create overlay file: {}", e))
                })?;
                sparse_copy(&mut entry, &mut out).map_err(|e| {
                    ApiError::Internal(format!("failed to extract overlay: {}", e))
                })?;
            }
            name if name == STORAGE_DISK_FILENAME => {
                let dest = target_dir.join(STORAGE_DISK_FILENAME);
                let mut out = std::fs::File::create(&dest).map_err(|e| {
                    ApiError::Internal(format!("failed to create storage file: {}", e))
                })?;
                sparse_copy(&mut entry, &mut out).map_err(|e| {
                    ApiError::Internal(format!("failed to extract storage: {}", e))
                })?;
            }
            _ => {} // skip manifest and other entries
        }
    }

    Ok(())
}

/// Reconstruct disk images from a delta chain.
///
/// Walks the chain back to a full (version 1) snapshot, extracts the base,
/// then applies each delta in order (oldest → newest).
fn reconstruct_from_chain(
    snap_dir: &std::path::Path,
    archive_path: &std::path::Path,
    target_dir: &std::path::Path,
) -> Result<(), ApiError> {
    use flate2::read::GzDecoder;

    // Build the chain: collect archives from current back to base
    let mut chain = vec![archive_path.to_path_buf()];
    let mut current = archive_path.to_path_buf();

    for _ in 0..20 {
        // Safety limit
        let manifest = read_manifest_from_archive(&current)?;
        if manifest.snapshot_version <= 1 {
            break; // Found the base
        }
        // Find parent
        let parent_name = manifest.parent_snapshot.ok_or_else(|| {
            ApiError::Internal("incremental snapshot missing parent_snapshot field".into())
        })?;
        let parent_path = find_latest_archive(snap_dir, &parent_name).ok_or_else(|| {
            ApiError::Internal(format!(
                "parent snapshot '{}' not found locally — cannot reconstruct delta chain",
                parent_name
            ))
        })?;
        chain.push(parent_path.clone());
        current = parent_path;
    }

    // Reverse so base is first
    chain.reverse();

    // Step 1: Extract base (first in chain, must be full)
    let base_path = &chain[0];
    let base_manifest = read_manifest_from_archive(base_path)?;
    if base_manifest.snapshot_version >= 2 {
        return Err(ApiError::Internal(
            "delta chain base is not a full snapshot — chain is broken".into(),
        ));
    }
    extract_full_archive(base_path, target_dir)?;

    // Step 2: Apply each delta in order
    for delta_archive_path in &chain[1..] {
        let file = std::fs::File::open(delta_archive_path)
            .map_err(|e| ApiError::Internal(format!("failed to open delta archive: {}", e)))?;
        let dec = GzDecoder::new(file);
        let mut tar = tar::Archive::new(dec);

        for entry in tar
            .entries()
            .map_err(|e| ApiError::Internal(format!("failed to read delta tar entries: {}", e)))?
        {
            let mut entry = entry
                .map_err(|e| ApiError::Internal(format!("failed to read delta entry: {}", e)))?;
            let path = entry
                .path()
                .map_err(|e| ApiError::Internal(format!("failed to read delta path: {}", e)))?
                .to_path_buf();

            let filename = path
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or_default();

            match filename {
                "overlay.delta" => {
                    let mut delta_bytes = Vec::new();
                    std::io::Read::read_to_end(&mut entry, &mut delta_bytes).map_err(|e| {
                        ApiError::Internal(format!("failed to read overlay delta: {}", e))
                    })?;
                    let delta = super::delta::read_delta(&mut &delta_bytes[..]).map_err(|e| {
                        ApiError::Internal(format!("failed to parse overlay delta: {}", e))
                    })?;
                    let disk_path = target_dir.join(OVERLAY_DISK_FILENAME);
                    apply_delta_in_place(&disk_path, &delta)?;
                }
                "storage.delta" => {
                    let mut delta_bytes = Vec::new();
                    std::io::Read::read_to_end(&mut entry, &mut delta_bytes).map_err(|e| {
                        ApiError::Internal(format!("failed to read storage delta: {}", e))
                    })?;
                    let delta = super::delta::read_delta(&mut &delta_bytes[..]).map_err(|e| {
                        ApiError::Internal(format!("failed to parse storage delta: {}", e))
                    })?;
                    let disk_path = target_dir.join(STORAGE_DISK_FILENAME);
                    apply_delta_in_place(&disk_path, &delta)?;
                }
                _ => {} // skip manifest
            }
        }
    }

    Ok(())
}

/// Apply a delta to a disk image in place (seek + write changed blocks).
fn apply_delta_in_place(
    disk_path: &std::path::Path,
    delta: &super::delta::DeltaResult,
) -> Result<(), ApiError> {
    use std::io::{Seek, SeekFrom, Write};

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(disk_path)
        .map_err(|e| ApiError::Internal(format!("failed to open disk for delta: {}", e)))?;

    // Extend if needed
    let current_size = file
        .metadata()
        .map_err(|e| ApiError::Internal(format!("failed to get disk size: {}", e)))?
        .len();
    if delta.total_disk_size > current_size {
        file.set_len(delta.total_disk_size)
            .map_err(|e| ApiError::Internal(format!("failed to extend disk: {}", e)))?;
    }

    for (offset, data) in &delta.changed_blocks {
        file.seek(SeekFrom::Start(*offset))
            .map_err(|e| ApiError::Internal(format!("failed to seek in disk: {}", e)))?;
        file.write_all(data)
            .map_err(|e| ApiError::Internal(format!("failed to write delta block: {}", e)))?;
    }

    Ok(())
}

/// Pull (import) a snapshot into a new machine.
#[utoipa::path(
    post,
    path = "/api/v1/snapshots/{name}/pull",
    tag = "Machinees",
    params(
        ("name" = String, Path, description = "Snapshot name to import")
    ),
    request_body = PullSnapshotRequest,
    responses(
        (status = 200, description = "Machine created from snapshot", body = MachineInfo),
        (status = 404, description = "Snapshot not found", body = ApiErrorResponse),
        (status = 409, description = "Machine name already exists", body = ApiErrorResponse),
        (status = 500, description = "Import failed", body = ApiErrorResponse)
    )
)]
pub async fn pull_snapshot(
    State(state): State<Arc<ApiState>>,
    Path(snapshot_name): Path<String>,
    Json(req): Json<PullSnapshotRequest>,
) -> Result<Json<MachineInfo>, ApiError> {
    let archive_path = snapshots_dir().join(format!("{}.smolvm", snapshot_name));
    if !archive_path.exists() {
        return Err(ApiError::NotFound(format!(
            "snapshot '{}' not found",
            snapshot_name
        )));
    }

    // Reserve the machine name (RAII guard auto-releases on error)
    let guard = ReservationGuard::new(&state, req.name.clone())?;

    // Extract disks to new machine directory
    let target_dir = vm_data_dir(&req.name);
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| ApiError::Internal(format!("failed to create machine dir: {}", e)))?;

    let target_dir_clone = target_dir.clone();
    let snap_dir = snapshots_dir();
    let manifest = tokio::task::spawn_blocking(move || -> Result<SnapshotManifest, ApiError> {
        // First, read the manifest to check snapshot_version
        let manifest = read_manifest_from_archive(&archive_path)?;

        if manifest.snapshot_version >= 2 {
            // Incremental snapshot — reconstruct from delta chain
            reconstruct_from_chain(&snap_dir, &archive_path, &target_dir_clone)?;
        } else {
            // Full snapshot — extract directly (existing path)
            extract_full_archive(&archive_path, &target_dir_clone)?;
        }
        Ok(manifest)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    // Mark extracted disks as formatted so start() doesn't overwrite them with templates
    {
        let storage_marker = target_dir.join("storage.formatted");
        let overlay_marker = target_dir.join("overlay.formatted");
        let _ = std::fs::write(&storage_marker, "1");
        let _ = std::fs::write(&overlay_marker, "1");
        // Write origin marker for lineage tracking
        let origin_marker = target_dir.join(".smolvm_origin");
        let _ = std::fs::write(&origin_marker, &snapshot_name);
    }

    // Create AgentManager from the extracted disks (open_or_create_at opens existing files)
    let machine_name = req.name.clone();
    let overlay_size = manifest.overlay_size_bytes;
    let storage_size = manifest.storage_size_bytes;
    let manager_result = tokio::task::spawn_blocking(move || {
        let data_dir = vm_data_dir(&machine_name);
        let storage_path = data_dir.join(STORAGE_DISK_FILENAME);
        let overlay_path = data_dir.join(OVERLAY_DISK_FILENAME);

        // Convert bytes to GB for open_or_create_at (use at least defaults)
        let storage_gb = std::cmp::max(
            storage_size / (1024 * 1024 * 1024),
            crate::storage::DEFAULT_STORAGE_SIZE_GIB,
        );
        let overlay_gb = std::cmp::max(
            overlay_size / (1024 * 1024 * 1024),
            crate::storage::DEFAULT_OVERLAY_SIZE_GIB,
        );

        let storage_disk = StorageDisk::open_or_create_at(&storage_path, storage_gb)?;
        let overlay_disk = OverlayDisk::open_or_create_at(&overlay_path, overlay_gb)?;

        let rootfs_path = AgentManager::default_rootfs_path()?;
        AgentManager::new_named(&machine_name, rootfs_path, storage_disk, overlay_disk)
    })
    .await;

    let manager = match manager_result {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => return Err(ApiError::internal(e)),
        Err(e) => return Err(ApiError::internal(e)),
    };

    let agent_state = manager.state().to_string();
    let pid = manager.child_pid();
    let network = manifest.network;

    // Register the machine with the server.
    // Note: snapshot manifests don't store full machine config (secrets, MCP,
    // RBAC, egress filters). These default to empty. The user can reconfigure
    // after pull via the API if needed.
    let resources = ResourceSpec::default();
    guard.complete(MachineRegistration {
        manager,
        mounts: vec![],
        ports: vec![],
        resources: resources.clone(),
        restart: crate::config::RestartConfig::default(),
        network,
        allowed_domains: None,
        secrets: vec![],
        default_env: vec![],
        owner_token_hash: None,
        mcp_servers: vec![],
    })?;

    Ok(Json(MachineInfo {
        name: req.name,
        state: agent_state,
        pid,
        mounts: vec![],
        ports: vec![],
        resources,
        network,
        restart_count: None,
    }))
}

/// Delete a snapshot.
#[utoipa::path(
    delete,
    path = "/api/v1/snapshots/{name}",
    tag = "Machinees",
    params(
        ("name" = String, Path, description = "Snapshot name to delete")
    ),
    responses(
        (status = 200, description = "Snapshot deleted"),
        (status = 404, description = "Snapshot not found", body = ApiErrorResponse)
    )
)]
pub async fn delete_snapshot(
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let archive_path = snapshots_dir().join(format!("{}.smolvm", name));
    if !archive_path.exists() {
        return Err(ApiError::NotFound(format!(
            "snapshot '{}' not found",
            name
        )));
    }

    std::fs::remove_file(&archive_path)
        .map_err(|e| ApiError::Internal(format!("failed to delete snapshot: {}", e)))?;

    // Clean up sidecar .sha256 file if it exists
    let sidecar_path = snapshots_dir().join(format!("{}.smolvm.sha256", name));
    let _ = std::fs::remove_file(&sidecar_path);

    Ok(Json(serde_json::json!({ "deleted": name })))
}

/// Download a snapshot archive as a streaming binary file.
#[utoipa::path(
    get,
    path = "/api/v1/snapshots/{name}/download",
    tag = "Machinees",
    params(
        ("name" = String, Path, description = "Snapshot name to download")
    ),
    responses(
        (status = 200, description = "Snapshot archive stream", content_type = "application/octet-stream"),
        (status = 404, description = "Snapshot not found", body = ApiErrorResponse)
    )
)]
pub async fn download_snapshot(
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let archive_path = snapshots_dir().join(format!("{}.smolvm", name));
    if !archive_path.exists() {
        return Err(ApiError::NotFound(format!(
            "snapshot '{}' not found",
            name
        )));
    }

    // Get file metadata for Content-Length
    let metadata = tokio::fs::metadata(&archive_path)
        .await
        .map_err(|e| ApiError::Internal(format!("failed to read file metadata: {}", e)))?;
    let file_size = metadata.len();

    // Open file for streaming
    let file = tokio::fs::File::open(&archive_path)
        .await
        .map_err(|e| ApiError::Internal(format!("failed to open snapshot file: {}", e)))?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    // Build response headers
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{}.smolvm\"", name)
            .parse()
            .unwrap(),
    );
    headers.insert(header::CONTENT_LENGTH, file_size.into());

    // Include SHA-256 from sidecar if available
    let sidecar_path = snapshots_dir().join(format!("{}.smolvm.sha256", name));
    if let Ok(hash) = tokio::fs::read_to_string(&sidecar_path).await {
        if let Ok(val) = hash.trim().parse() {
            headers.insert("x-smolvm-sha256", val);
        }
    }

    Ok((StatusCode::OK, headers, body))
}

/// Upload a snapshot archive from streaming binary body.
#[utoipa::path(
    post,
    path = "/api/v1/snapshots/upload",
    tag = "Machinees",
    params(
        ("name" = String, Query, description = "Name for the uploaded snapshot")
    ),
    request_body(content_type = "application/octet-stream", description = "Raw .smolvm archive bytes"),
    responses(
        (status = 200, description = "Snapshot uploaded successfully", body = UploadSnapshotResponse),
        (status = 400, description = "Invalid archive or checksum mismatch", body = ApiErrorResponse),
        (status = 500, description = "Upload failed", body = ApiErrorResponse)
    )
)]
pub async fn upload_snapshot(
    Query(query): Query<UploadSnapshotQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<UploadSnapshotResponse>, ApiError> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let name = query.name;
    let snap_dir = snapshots_dir();
    std::fs::create_dir_all(&snap_dir)
        .map_err(|e| ApiError::Internal(format!("failed to create snapshots dir: {}", e)))?;

    // Stream body to a temp file, then rename atomically
    let temp_path = snap_dir.join(format!(".{}.smolvm.tmp", name));
    let final_path = snap_dir.join(format!("{}.smolvm", name));

    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| ApiError::Internal(format!("failed to create temp file: {}", e)))?;

    let mut hasher = Sha256::new();
    let mut total_bytes: u64 = 0;
    let mut stream = body.into_data_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ApiError::Internal(format!("failed to read body chunk: {}", e)))?;
        hasher.update(&chunk);
        total_bytes += chunk.len() as u64;
        file.write_all(&chunk)
            .await
            .map_err(|e| ApiError::Internal(format!("failed to write chunk: {}", e)))?;
    }

    file.flush()
        .await
        .map_err(|e| ApiError::Internal(format!("failed to flush file: {}", e)))?;
    drop(file);

    let computed_sha256 = format!("{:x}", hasher.finalize());

    // Validate checksum if client provided one
    if let Some(expected) = headers.get("x-smolvm-sha256").and_then(|v| v.to_str().ok()) {
        if expected.trim() != computed_sha256 {
            // Clean up temp file
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(ApiError::BadRequest(format!(
                "SHA-256 mismatch: expected {}, got {}",
                expected.trim(),
                computed_sha256
            )));
        }
    }

    // Rename temp file to final location
    tokio::fs::rename(&temp_path, &final_path)
        .await
        .map_err(|e| ApiError::Internal(format!("failed to rename snapshot file: {}", e)))?;

    // Read manifest from the archive
    let final_path_clone = final_path.clone();
    let manifest = tokio::task::spawn_blocking(move || read_manifest_from_archive(&final_path_clone))
        .await
        .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    // Write SHA-256 sidecar file
    let sidecar_path = snap_dir.join(format!("{}.smolvm.sha256", name));
    let _ = tokio::fs::write(&sidecar_path, &computed_sha256).await;

    Ok(Json(UploadSnapshotResponse {
        name,
        size_bytes: total_bytes,
        manifest,
    }))
}

/// Get snapshot version history.
#[utoipa::path(
    get,
    path = "/api/v1/snapshots/{name}/history",
    tag = "Machinees",
    params(
        ("name" = String, Path, description = "Snapshot name")
    ),
    responses(
        (status = 200, description = "Snapshot history", body = SnapshotHistoryResponse),
        (status = 404, description = "Snapshot not found", body = ApiErrorResponse)
    )
)]
pub async fn snapshot_history(
    Path(name): Path<String>,
) -> Result<Json<SnapshotHistoryResponse>, ApiError> {
    let snap_dir = snapshots_dir();

    // Collect all versioned archives for this name
    let snap_dir_clone = snap_dir.clone();
    let name_clone = name.clone();
    let chain = tokio::task::spawn_blocking(move || -> Result<Vec<(std::path::PathBuf, SnapshotManifest)>, ApiError> {
        let mut versions = Vec::new();
        let prefix = format!("{}.v", name_clone);

        if let Ok(entries) = std::fs::read_dir(&snap_dir_clone) {
            for entry in entries.flatten() {
                let fname = entry.file_name();
                let fname_str = fname.to_string_lossy();
                if let Some(rest) = fname_str.strip_prefix(&prefix) {
                    if rest.ends_with(".smolvm") && !rest.contains(".sha256") {
                        if let Ok(manifest) = read_manifest_from_archive(&entry.path()) {
                            versions.push((entry.path(), manifest));
                        }
                    }
                }
            }
        }

        // Also check legacy {name}.smolvm if no versioned files found
        if versions.is_empty() {
            let legacy = snap_dir_clone.join(format!("{}.smolvm", name_clone));
            if legacy.exists() {
                if let Ok(manifest) = read_manifest_from_archive(&legacy) {
                    versions.push((legacy, manifest));
                }
            }
        }

        // Sort by sequence (or created_at as fallback)
        versions.sort_by(|a, b| {
            let seq_a = a.1.sequence.unwrap_or(0);
            let seq_b = b.1.sequence.unwrap_or(0);
            seq_b.cmp(&seq_a) // newest first
        });

        Ok(versions)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    if chain.is_empty() {
        return Err(ApiError::NotFound(format!("no snapshots found for '{}'", name)));
    }

    let total_size_bytes: u64 = chain.iter().map(|(p, _)| {
        std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
    }).sum();

    let full_snapshots = chain.iter().filter(|(_, m)| m.snapshot_version <= 1).count();
    let incremental_snapshots = chain.iter().filter(|(_, m)| m.snapshot_version >= 2).count();

    let manifests: Vec<SnapshotManifest> = chain.into_iter().map(|(_, m)| m).collect();

    Ok(Json(SnapshotHistoryResponse {
        total_snapshots: manifests.len(),
        full_snapshots,
        incremental_snapshots,
        total_size_bytes,
        chain: manifests,
    }))
}

/// Rollback a machine to a specific snapshot version.
#[utoipa::path(
    post,
    path = "/api/v1/snapshots/{name}/rollback",
    tag = "Machinees",
    params(
        ("name" = String, Path, description = "Snapshot name")
    ),
    request_body = RollbackRequest,
    responses(
        (status = 200, description = "Machine rolled back", body = RollbackResponse),
        (status = 404, description = "Snapshot or machine not found", body = ApiErrorResponse),
        (status = 500, description = "Rollback failed", body = ApiErrorResponse)
    )
)]
pub async fn snapshot_rollback(
    State(state): State<Arc<ApiState>>,
    Path(snapshot_name): Path<String>,
    Json(req): Json<RollbackRequest>,
) -> Result<Json<RollbackResponse>, ApiError> {
    let snap_dir = snapshots_dir();

    // Find the specific version or latest
    let archive_path = if let Some(version) = req.version {
        let versioned = snap_dir.join(format!("{}.v{}.smolvm", snapshot_name, version));
        if !versioned.exists() {
            return Err(ApiError::NotFound(format!(
                "snapshot '{}' version {} not found",
                snapshot_name, version
            )));
        }
        versioned
    } else {
        find_latest_archive(&snap_dir, &snapshot_name).ok_or_else(|| {
            ApiError::NotFound(format!("snapshot '{}' not found", snapshot_name))
        })?
    };

    let manifest = tokio::task::spawn_blocking({
        let path = archive_path.clone();
        move || read_manifest_from_archive(&path)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    // Stop machine if running
    let machine_name = req.machine_name.clone();
    let entry = state.get_machine(&machine_name)?;
    {
        let lock = entry.lock();
        if lock.manager.state().to_string() == "running" {
            let _ = lock.manager.stop();
        }
    }

    // Replace disk images
    let target_dir = vm_data_dir(&machine_name);
    let snap_dir_for_chain = snap_dir.clone();
    tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        // Remove existing disks
        let _ = std::fs::remove_file(target_dir.join(OVERLAY_DISK_FILENAME));
        let _ = std::fs::remove_file(target_dir.join(STORAGE_DISK_FILENAME));

        if manifest.snapshot_version >= 2 {
            reconstruct_from_chain(&snap_dir_for_chain, &archive_path, &target_dir)
        } else {
            extract_full_archive(&archive_path, &target_dir)
        }
    })
    .await
    .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    // Re-read manifest for response
    let response_manifest = tokio::task::spawn_blocking({
        let path = if let Some(version) = req.version {
            snap_dir.join(format!("{}.v{}.smolvm", snapshot_name, version))
        } else {
            find_latest_archive(&snap_dir, &snapshot_name).unwrap_or_default()
        };
        move || read_manifest_from_archive(&path)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("spawn_blocking failed: {}", e)))??;

    Ok(Json(RollbackResponse {
        machine_name: req.machine_name,
        restored_version: response_manifest.sequence.unwrap_or(1),
        manifest: response_manifest,
    }))
}

/// Read a manifest from a .smolvm archive.
fn read_manifest_from_archive(path: &std::path::Path) -> Result<SnapshotManifest, ApiError> {
    use flate2::read::GzDecoder;

    let file = std::fs::File::open(path)
        .map_err(|e| ApiError::Internal(format!("failed to open archive: {}", e)))?;
    let dec = GzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);

    for entry in tar
        .entries()
        .map_err(|e| ApiError::Internal(format!("failed to read tar: {}", e)))?
    {
        let mut entry =
            entry.map_err(|e| ApiError::Internal(format!("failed to read entry: {}", e)))?;
        let path = entry
            .path()
            .map_err(|e| ApiError::Internal(format!("path error: {}", e)))?
            .to_path_buf();
        if path.file_name().and_then(|f| f.to_str()) == Some("manifest.json") {
            let mut contents = String::new();
            std::io::Read::read_to_string(&mut entry, &mut contents)
                .map_err(|e| ApiError::Internal(format!("failed to read manifest: {}", e)))?;
            return serde_json::from_str(&contents)
                .map_err(|e| ApiError::Internal(format!("failed to parse manifest: {}", e)));
        }
    }

    Err(ApiError::Internal("no manifest.json in archive".into()))
}
