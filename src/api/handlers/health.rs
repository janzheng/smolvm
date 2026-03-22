//! Health check and metrics endpoints.

use axum::{extract::State, Json};
use std::sync::Arc;

use crate::api::state::ApiState;
use crate::api::types::HealthResponse;

/// Health check endpoint.
#[utoipa::path(
    get,
    path = "/health",
    tag = "Health",
    responses(
        (status = 200, description = "Server is healthy", body = HealthResponse)
    )
)]
pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: crate::VERSION,
    })
}

/// Prometheus metrics endpoint.
///
/// Returns metrics in Prometheus text exposition format.
pub async fn metrics(State(state): State<Arc<ApiState>>) -> String {
    // Update active sandbox gauge before rendering
    let count = state.list_sandboxes().len() as u64;
    crate::api::metrics::set_active_sandboxes(count);
    state.metrics_handle.render()
}
