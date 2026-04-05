//! Permission management handlers for sandbox RBAC.

use axum::{
    extract::{Path, State},
    Json,
};
use std::sync::Arc;

use crate::api::auth::{check_permission, extract_bearer_token, hash_token};
use crate::api::error::ApiError;
use crate::api::state::ApiState;
use crate::api::types::{
    ApiErrorResponse, GrantPermissionRequest, ListPermissionsResponse, PermissionResponse,
    MachinePermission, MachineRole,
};

/// Grant a role to a token on a sandbox.
///
/// Only the sandbox Owner can grant permissions.
#[utoipa::path(
    post,
    path = "/api/v1/machines/{id}/permissions",
    tag = "Permissions",
    params(
        ("id" = String, Path, description = "Machine name")
    ),
    request_body = GrantPermissionRequest,
    responses(
        (status = 200, description = "Permission granted", body = PermissionResponse),
        (status = 403, description = "Forbidden — not the sandbox owner", body = ApiErrorResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse)
    )
)]
pub async fn grant_permission(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(req): Json<GrantPermissionRequest>,
) -> Result<Json<PermissionResponse>, ApiError> {
    let token = extract_bearer_token(&headers)
        .ok_or_else(|| ApiError::Unauthorized("missing bearer token".into()))?;

    // Only Owner can grant permissions
    check_permission(&state, &id, &token, MachineRole::Owner)?;

    let grant_hash = hash_token(&req.token);

    let entry = state.get_machine(&id)?;
    let mut entry = entry.lock();

    // Check if this token already has a permission — update it
    let mut found = false;
    for perm in &mut entry.permissions {
        if perm.token_hash == grant_hash {
            perm.role = req.role.clone();
            found = true;
            break;
        }
    }

    if !found {
        entry.permissions.push(MachinePermission {
            token_hash: grant_hash.clone(),
            role: req.role.clone(),
        });
    }

    Ok(Json(PermissionResponse {
        message: format!(
            "granted '{}' role to token hash '{}' on sandbox '{}'",
            req.role, grant_hash, id
        ),
    }))
}

/// List permissions on a sandbox.
///
/// Only the sandbox Owner can view permissions.
#[utoipa::path(
    get,
    path = "/api/v1/machines/{id}/permissions",
    tag = "Permissions",
    params(
        ("id" = String, Path, description = "Machine name")
    ),
    responses(
        (status = 200, description = "Permission list", body = ListPermissionsResponse),
        (status = 403, description = "Forbidden — not the sandbox owner", body = ApiErrorResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse)
    )
)]
pub async fn list_permissions(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ListPermissionsResponse>, ApiError> {
    let token = extract_bearer_token(&headers)
        .ok_or_else(|| ApiError::Unauthorized("missing bearer token".into()))?;

    // Only Owner can view permissions
    check_permission(&state, &id, &token, MachineRole::Owner)?;

    let entry = state.get_machine(&id)?;
    let entry = entry.lock();

    Ok(Json(ListPermissionsResponse {
        sandbox: id,
        permissions: entry.permissions.clone(),
    }))
}

/// Revoke a permission from a sandbox.
///
/// Only the sandbox Owner can revoke permissions. Cannot revoke your own Owner role.
#[utoipa::path(
    delete,
    path = "/api/v1/machines/{id}/permissions/{token_hash}",
    tag = "Permissions",
    params(
        ("id" = String, Path, description = "Machine name"),
        ("token_hash" = String, Path, description = "Token hash to revoke")
    ),
    responses(
        (status = 200, description = "Permission revoked", body = PermissionResponse),
        (status = 400, description = "Cannot revoke own Owner role", body = ApiErrorResponse),
        (status = 403, description = "Forbidden — not the sandbox owner", body = ApiErrorResponse),
        (status = 404, description = "Machine or permission not found", body = ApiErrorResponse)
    )
)]
pub async fn revoke_permission(
    State(state): State<Arc<ApiState>>,
    Path((id, target_hash)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
) -> Result<Json<PermissionResponse>, ApiError> {
    let token = extract_bearer_token(&headers)
        .ok_or_else(|| ApiError::Unauthorized("missing bearer token".into()))?;

    // Only Owner can revoke permissions
    check_permission(&state, &id, &token, MachineRole::Owner)?;

    let caller_hash = hash_token(&token);

    // Prevent revoking your own Owner role
    if target_hash == caller_hash {
        return Err(ApiError::BadRequest(
            "cannot revoke your own Owner permission".into(),
        ));
    }

    let entry = state.get_machine(&id)?;
    let mut entry = entry.lock();

    let original_len = entry.permissions.len();
    entry.permissions.retain(|p| p.token_hash != target_hash);

    if entry.permissions.len() == original_len {
        return Err(ApiError::NotFound(format!(
            "no permission found for token hash '{}' on sandbox '{}'",
            target_hash, id
        )));
    }

    Ok(Json(PermissionResponse {
        message: format!(
            "revoked permission for token hash '{}' on sandbox '{}'",
            target_hash, id
        ),
    }))
}
