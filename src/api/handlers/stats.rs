//! Resource statistics endpoint.

use axum::{
    extract::{Path, State},
    Json,
};
use std::sync::Arc;

use crate::agent::vm_data_dir;
use crate::api::error::ApiError;
use crate::api::state::ApiState;
use crate::api::types::{ApiErrorResponse, DiskStats, ResourceStatsResponse};

/// Get resource statistics for a sandbox.
#[utoipa::path(
    get,
    path = "/api/v1/sandboxes/{id}/stats",
    tag = "Sandboxes",
    params(
        ("id" = String, Path, description = "Sandbox name")
    ),
    responses(
        (status = 200, description = "Resource statistics", body = ResourceStatsResponse),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse)
    )
)]
pub async fn sandbox_stats(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
) -> Result<Json<ResourceStatsResponse>, ApiError> {
    let entry = state.get_sandbox(&id)?;
    let entry = entry.lock();

    let (effective_state, pid) = entry.manager.effective_status();

    // Get configured resources
    let cpus = entry.resources.cpus.unwrap_or(crate::agent::DEFAULT_CPUS);
    let memory_mb = entry
        .resources
        .memory_mb
        .unwrap_or(crate::agent::DEFAULT_MEMORY_MIB);

    // Get disk usage from host-side file sizes
    let data_dir = vm_data_dir(&id);
    let overlay_path = data_dir.join(crate::storage::OVERLAY_DISK_FILENAME);
    let storage_path = data_dir.join(crate::storage::STORAGE_DISK_FILENAME);

    let overlay_disk = disk_stats(&overlay_path);
    let storage_disk = disk_stats(&storage_path);

    Ok(Json(ResourceStatsResponse {
        name: id,
        state: effective_state.to_string(),
        pid,
        cpus,
        memory_mb,
        network: entry.network,
        overlay_disk,
        storage_disk,
    }))
}

/// Get size stats for a disk file.
fn disk_stats(path: &std::path::Path) -> Option<DiskStats> {
    let metadata = std::fs::metadata(path).ok()?;
    let apparent_size_bytes = metadata.len();

    Some(DiskStats {
        path: path.to_string_lossy().to_string(),
        apparent_size_bytes,
        apparent_size_gb: apparent_size_bytes as f64 / (1024.0 * 1024.0 * 1024.0),
    })
}
