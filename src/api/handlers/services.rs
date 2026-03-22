//! Service definition management handlers.
//!
//! Provides endpoints to list and register custom proxy service definitions.

use axum::{extract::State, Json};
use std::sync::Arc;

use crate::api::error::ApiError;
use crate::api::state::ApiState;
use crate::api::types::{
    ApiErrorResponse, CreateServiceRequest, ListServicesResponse, ServiceInfo,
};

/// List all available proxy service definitions.
#[utoipa::path(
    get,
    path = "/api/v1/services",
    tag = "Services",
    responses(
        (status = 200, description = "List of available services", body = ListServicesResponse)
    )
)]
pub async fn list_services(
    State(state): State<Arc<ApiState>>,
) -> Json<ListServicesResponse> {
    let services = state.list_services();
    Json(ListServicesResponse { services })
}

/// Register a new proxy service definition at runtime.
#[utoipa::path(
    post,
    path = "/api/v1/services",
    tag = "Services",
    request_body = CreateServiceRequest,
    responses(
        (status = 201, description = "Service registered", body = ServiceInfo),
        (status = 400, description = "Invalid request", body = ApiErrorResponse)
    )
)]
pub async fn create_service(
    State(state): State<Arc<ApiState>>,
    Json(req): Json<CreateServiceRequest>,
) -> Result<(axum::http::StatusCode, Json<ServiceInfo>), ApiError> {
    // Validate required fields
    if req.name.is_empty() {
        return Err(ApiError::BadRequest("name cannot be empty".into()));
    }
    if req.base_url.is_empty() {
        return Err(ApiError::BadRequest("base_url cannot be empty".into()));
    }
    if req.auth_header.is_empty() {
        return Err(ApiError::BadRequest("auth_header cannot be empty".into()));
    }
    if req.env_key_name.is_empty() {
        return Err(ApiError::BadRequest("env_key_name cannot be empty".into()));
    }
    if req.env_url_name.is_empty() {
        return Err(ApiError::BadRequest("env_url_name cannot be empty".into()));
    }

    let service = crate::proxy::SecretService {
        name: req.name.clone(),
        base_url: req.base_url.clone(),
        auth_header: req.auth_header.clone(),
        auth_prefix: req.auth_prefix.unwrap_or_default(),
        env_key_name: req.env_key_name.clone(),
        env_url_name: req.env_url_name.clone(),
    };

    let info = ServiceInfo {
        name: service.name.clone(),
        base_url: service.base_url.clone(),
        auth_header: service.auth_header.clone(),
        auth_prefix: service.auth_prefix.clone(),
        env_key_name: service.env_key_name.clone(),
        env_url_name: service.env_url_name.clone(),
    };

    state.register_service(service);

    tracing::info!(service = %req.name, "service registered");

    Ok((axum::http::StatusCode::CREATED, Json(info)))
}
