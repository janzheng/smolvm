//! Secret management endpoints for hot-reloading API keys.

use axum::{extract::State, Json};
use std::sync::Arc;

use crate::api::error::ApiError;
use crate::api::state::ApiState;
use crate::api::types::{ListSecretsResponse, UpdateSecretsRequest, UpdateSecretsResponse};

/// List configured secret names and services (never exposes values).
#[utoipa::path(
    get,
    path = "/api/v1/secrets",
    tag = "Secrets",
    responses(
        (status = 200, description = "List of configured secret and service names", body = ListSecretsResponse),
        (status = 400, description = "No proxy config (server started without --secret)")
    )
)]
pub async fn list_secrets(
    State(state): State<Arc<ApiState>>,
) -> Result<Json<ListSecretsResponse>, ApiError> {
    match state.list_secret_names() {
        Some((secrets, services)) => Ok(Json(ListSecretsResponse { secrets, services })),
        None => Err(ApiError::BadRequest(
            "no secrets configured on server. Start the server with --secret NAME=VALUE.".to_string(),
        )),
    }
}

/// Update secrets at runtime without restarting the server.
///
/// Merges the provided secrets into the existing configuration.
/// New secrets are added, existing secrets are overwritten.
/// Note: Running machinees use a copy of secrets from when they were created;
/// only new machine creations will pick up the updated secrets.
#[utoipa::path(
    put,
    path = "/api/v1/secrets",
    tag = "Secrets",
    request_body = UpdateSecretsRequest,
    responses(
        (status = 200, description = "Secrets updated successfully", body = UpdateSecretsResponse),
        (status = 400, description = "No proxy config (server started without --secret)")
    )
)]
pub async fn update_secrets(
    State(state): State<Arc<ApiState>>,
    Json(req): Json<UpdateSecretsRequest>,
) -> Result<Json<UpdateSecretsResponse>, ApiError> {
    match state.update_secrets(req.secrets) {
        Some(updated) => {
            tracing::info!(count = updated.len(), names = ?updated, "secrets updated via API");
            Ok(Json(UpdateSecretsResponse { updated }))
        }
        None => Err(ApiError::BadRequest(
            "no secrets configured on server. Start the server with --secret NAME=VALUE.".to_string(),
        )),
    }
}
