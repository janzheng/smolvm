//! Provider information endpoint.

use axum::Json;

use crate::api::types::ProviderInfoResponse;

/// Get provider information.
///
/// Returns metadata about the current machine provider (name, version,
/// capabilities, region).
#[utoipa::path(
    get,
    path = "/api/v1/provider",
    tag = "Provider",
    responses(
        (status = 200, description = "Provider info", body = ProviderInfoResponse)
    )
)]
pub async fn get_provider_info() -> Json<ProviderInfoResponse> {
    Json(ProviderInfoResponse {
        name: "local".into(),
        version: crate::VERSION.into(),
        capabilities: vec![
            "exec".into(),
            "files".into(),
            "mcp".into(),
            "secrets".into(),
            "merge".into(),
            "clone".into(),
            "snapshots".into(),
            "containers".into(),
            "images".into(),
        ],
        max_machinees: None,
        region: Some("local".into()),
    })
}
