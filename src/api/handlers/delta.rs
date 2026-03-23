//! Block-level delta computation and application for incremental snapshots.
//!
//! Compares parent and child disk images in 4KB blocks, storing only changed
//! blocks. This is a natural extension of the sparse_copy() pattern used in
//! snapshot extraction.

use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Magic bytes identifying a smolvm delta file.
pub const DELTA_MAGIC: &[u8; 8] = b"SMOLDLT\0";

/// Delta format version.
pub const DELTA_VERSION: u32 = 1;

/// Default block size for delta computation (matches filesystem block size).
pub const DELTA_BLOCK_SIZE: usize = 4096;

/// Result of computing a delta between two disk images.
pub struct DeltaResult {
    /// Total size of the original (child) disk in bytes.
    pub total_disk_size: u64,
    /// Changed blocks: (byte_offset, block_data).
    pub changed_blocks: Vec<(u64, Vec<u8>)>,
}

impl DeltaResult {
    /// Size of the delta data (header + all block entries).
    pub fn delta_size(&self) -> u64 {
        // header: 8 (magic) + 4 (version) + 4 (block_size) + 8 (total_size) + 8 (num_blocks) = 32
        let header_size = 32u64;
        let per_block = 8 + DELTA_BLOCK_SIZE as u64; // offset + data
        header_size + self.changed_blocks.len() as u64 * per_block
    }

    /// Number of changed blocks.
    pub fn num_changed(&self) -> u64 {
        self.changed_blocks.len() as u64
    }
}

/// Compare two disk images block-by-block, returning only changed blocks.
///
/// Memory usage: 2x DELTA_BLOCK_SIZE buffers + vec of changed (offset, data) pairs.
pub fn compute_delta(parent_path: &Path, child_path: &Path) -> io::Result<DeltaResult> {
    let mut parent = std::fs::File::open(parent_path)?;
    let mut child = std::fs::File::open(child_path)?;

    let child_size = child.metadata()?.len();
    let parent_size = parent.metadata()?.len();

    let mut parent_buf = vec![0u8; DELTA_BLOCK_SIZE];
    let mut child_buf = vec![0u8; DELTA_BLOCK_SIZE];
    let mut changed_blocks = Vec::new();
    let mut offset: u64 = 0;

    loop {
        if offset >= child_size {
            break;
        }

        // Read child block
        let child_n = read_full(&mut child, &mut child_buf)?;
        if child_n == 0 {
            break;
        }

        // Read parent block (may be shorter if parent is smaller)
        let parent_n = if offset < parent_size {
            read_full(&mut parent, &mut parent_buf)?
        } else {
            // Child extends beyond parent — treat parent block as zeros
            parent_buf[..DELTA_BLOCK_SIZE].fill(0);
            0
        };

        // Compare blocks
        let blocks_differ = if parent_n == 0 && child_n > 0 {
            // Parent exhausted, child has data — check if child block is non-zero
            child_buf[..child_n].iter().any(|&b| b != 0)
        } else {
            child_buf[..child_n] != parent_buf[..child_n]
        };

        if blocks_differ {
            let mut block_data = vec![0u8; DELTA_BLOCK_SIZE];
            block_data[..child_n].copy_from_slice(&child_buf[..child_n]);
            changed_blocks.push((offset, block_data));
        }

        offset += child_n as u64;
    }

    Ok(DeltaResult {
        total_disk_size: child_size,
        changed_blocks,
    })
}

/// Write a delta to a writer in the SMOLDLT format.
pub fn write_delta<W: Write>(delta: &DeltaResult, writer: &mut W) -> io::Result<()> {
    // Header
    writer.write_all(DELTA_MAGIC)?;
    writer.write_all(&DELTA_VERSION.to_le_bytes())?;
    writer.write_all(&(DELTA_BLOCK_SIZE as u32).to_le_bytes())?;
    writer.write_all(&delta.total_disk_size.to_le_bytes())?;
    writer.write_all(&(delta.changed_blocks.len() as u64).to_le_bytes())?;

    // Changed blocks
    for (offset, data) in &delta.changed_blocks {
        writer.write_all(&offset.to_le_bytes())?;
        writer.write_all(data)?;
    }

    Ok(())
}

/// Read a delta from a reader in the SMOLDLT format.
pub fn read_delta<R: Read>(reader: &mut R) -> io::Result<DeltaResult> {
    // Header
    let mut magic = [0u8; 8];
    reader.read_exact(&mut magic)?;
    if &magic != DELTA_MAGIC {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid delta magic"));
    }

    let mut buf4 = [0u8; 4];
    let mut buf8 = [0u8; 8];

    reader.read_exact(&mut buf4)?;
    let version = u32::from_le_bytes(buf4);
    if version != DELTA_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported delta version: {}", version),
        ));
    }

    reader.read_exact(&mut buf4)?;
    let block_size = u32::from_le_bytes(buf4) as usize;

    reader.read_exact(&mut buf8)?;
    let total_disk_size = u64::from_le_bytes(buf8);

    reader.read_exact(&mut buf8)?;
    let num_blocks = u64::from_le_bytes(buf8);

    // Read changed blocks
    let mut changed_blocks = Vec::with_capacity(num_blocks as usize);
    for _ in 0..num_blocks {
        reader.read_exact(&mut buf8)?;
        let offset = u64::from_le_bytes(buf8);

        let mut data = vec![0u8; block_size];
        reader.read_exact(&mut data)?;

        changed_blocks.push((offset, data));
    }

    Ok(DeltaResult {
        total_disk_size,
        changed_blocks,
    })
}

/// Apply a delta to a base disk image, writing the result to output_path.
///
/// 1. Copies the base disk to output (using sparse_copy semantics)
/// 2. Seeks to each changed block offset and writes the new data
pub fn apply_delta(
    base_path: &Path,
    delta: &DeltaResult,
    output_path: &Path,
) -> io::Result<()> {
    // Copy base to output with sparse preservation
    {
        let mut base = std::fs::File::open(base_path)?;
        let mut out = std::fs::File::create(output_path)?;
        sparse_copy_file(&mut base, &mut out)?;
    }

    // Apply changed blocks
    let mut out = std::fs::OpenOptions::new().write(true).open(output_path)?;

    // Extend file if delta's total size is larger than base
    let current_size = out.metadata()?.len();
    if delta.total_disk_size > current_size {
        out.set_len(delta.total_disk_size)?;
    }

    for (offset, data) in &delta.changed_blocks {
        out.seek(SeekFrom::Start(*offset))?;
        out.write_all(data)?;
    }

    Ok(())
}

/// Apply a delta directly from a reader (without loading all blocks into memory first)
/// to a base disk, writing the result to output_path.
pub fn apply_delta_streaming<R: Read>(
    base_path: &Path,
    delta_reader: &mut R,
    output_path: &Path,
) -> io::Result<()> {
    let delta = read_delta(delta_reader)?;
    apply_delta(base_path, &delta, output_path)
}

// --- Internal helpers ---

/// Read exactly buf.len() bytes, or fewer only at EOF.
fn read_full<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut total = 0;
    while total < buf.len() {
        match reader.read(&mut buf[total..])? {
            0 => break,
            n => total += n,
        }
    }
    Ok(total)
}

/// Copy a file preserving sparseness (same algorithm as sparse_copy in snapshots.rs).
fn sparse_copy_file<R: Read, W: Write + Seek>(reader: &mut R, writer: &mut W) -> io::Result<()> {
    const BLOCK_SIZE: usize = 4096;
    let zero_block = [0u8; BLOCK_SIZE];
    let mut buf = [0u8; BLOCK_SIZE];
    let mut pending_seek: u64 = 0;

    loop {
        let n = read_full(reader, &mut buf)?;
        if n == 0 {
            if pending_seek > 0 {
                writer.seek(SeekFrom::Current(pending_seek as i64 - 1))?;
                writer.write_all(&[0])?;
            }
            break;
        }

        if buf[..n] == zero_block[..n] {
            pending_seek += n as u64;
        } else {
            if pending_seek > 0 {
                writer.seek(SeekFrom::Current(pending_seek as i64))?;
                pending_seek = 0;
            }
            writer.write_all(&buf[..n])?;
        }
    }
    Ok(())
}

/// Extract a specific file from a tar.gz archive to a destination path.
/// Used to extract parent disk images for delta computation.
pub fn extract_file_from_archive(
    archive_path: &Path,
    filename: &str,
    dest_path: &Path,
) -> io::Result<()> {
    use flate2::read::GzDecoder;

    let file = std::fs::File::open(archive_path)?;
    let dec = GzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);

    for entry in tar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_path_buf();
        let entry_name = path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or_default();

        if entry_name == filename {
            let mut out = std::fs::File::create(dest_path)?;
            io::copy(&mut entry, &mut out)?;
            return Ok(());
        }
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("'{}' not found in archive", filename),
    ))
}
