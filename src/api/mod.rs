//! HTTP API server for smolvm.
//!
//! This module provides an HTTP API for managing sandboxes, containers, and images
//! without CLI overhead.
//!
//! # Example
//!
//! ```bash
//! # Start the server
//! smolvm serve --listen 127.0.0.1:8080
//!
//! # Create a sandbox
//! curl -X POST http://localhost:8080/api/v1/sandboxes \
//!   -H "Content-Type: application/json" \
//!   -d '{"name": "test"}'
//! ```

pub mod auth;
pub mod dns_filter;
pub mod error;
pub mod handlers;
pub mod metrics;
pub mod starters;
pub mod state;
pub mod supervisor;
pub mod types;
pub mod validation;

use axum::{
    routing::{delete, get, post, put},
    Router,
};
use std::sync::Arc;
use std::time::Duration;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use state::ApiState;

/// OpenAPI documentation for the smolvm API.
#[derive(OpenApi)]
#[openapi(
    info(
        title = "smolvm API",
        version = "0.1.6",
        description = "OCI-native microVM runtime API for managing sandboxes, containers, images, and microvms.",
        license(name = "Apache-2.0", url = "https://www.apache.org/licenses/LICENSE-2.0")
    ),
    tags(
        (name = "Health", description = "Health check endpoints"),
        (name = "Sandboxes", description = "Sandbox lifecycle management"),
        (name = "Execution", description = "Command execution in sandboxes"),
        (name = "Logs", description = "Log streaming"),
        (name = "Files", description = "File CRUD operations in sandboxes"),
        (name = "Containers", description = "Container management within sandboxes"),
        (name = "Images", description = "OCI image management"),
        (name = "MicroVMs", description = "Persistent microVM management"),
        (name = "Jobs", description = "Work queue and job dispatch"),
        (name = "Secrets", description = "Secret management and hot-reload"),
        (name = "Services", description = "Proxy service definition management"),
        (name = "Permissions", description = "Sandbox RBAC permission management"),
        (name = "MCP", description = "Model Context Protocol server management and tool discovery"),
        (name = "Provider", description = "Provider information and capabilities")
    ),
    paths(
        // Health
        handlers::health::health,
        // Sandboxes
        handlers::sandboxes::create_sandbox,
        handlers::sandboxes::list_sandboxes,
        handlers::sandboxes::get_sandbox,
        handlers::sandboxes::start_sandbox,
        handlers::sandboxes::stop_sandbox,
        handlers::sandboxes::delete_sandbox,
        handlers::sandboxes::clone_sandbox,
        handlers::sandboxes::diff_sandboxes,
        handlers::sandboxes::merge_sandboxes,
        handlers::sandboxes::debug_mounts,
        handlers::sandboxes::debug_network,
        handlers::sandboxes::dns_filter_status,
        // Files
        handlers::files::read_file,
        handlers::files::write_file,
        handlers::files::delete_file,
        handlers::files::list_files,
        handlers::files::upload_file,
        handlers::files::upload_archive,
        handlers::files::download_archive,
        // Snapshots
        handlers::snapshots::push_sandbox,
        handlers::snapshots::list_snapshots,
        handlers::snapshots::pull_snapshot,
        handlers::snapshots::delete_snapshot,
        handlers::snapshots::download_snapshot,
        handlers::snapshots::upload_snapshot,
        // Execution
        handlers::exec::exec_command,
        handlers::exec::run_command,
        handlers::exec::stream_logs,
        // Containers
        handlers::containers::create_container,
        handlers::containers::list_containers,
        handlers::containers::start_container,
        handlers::containers::stop_container,
        handlers::containers::delete_container,
        handlers::containers::exec_in_container,
        // Images
        handlers::images::list_images,
        handlers::images::pull_image,
        // MicroVMs
        handlers::microvms::create_microvm,
        handlers::microvms::list_microvms,
        handlers::microvms::get_microvm,
        handlers::microvms::start_microvm,
        handlers::microvms::stop_microvm,
        handlers::microvms::delete_microvm,
        handlers::microvms::exec_microvm,
        handlers::microvms::resize_microvm,
        // Stats
        handlers::stats::sandbox_stats,
        // Jobs
        handlers::jobs::submit_job,
        handlers::jobs::list_jobs,
        handlers::jobs::get_job,
        handlers::jobs::poll_job,
        handlers::jobs::complete_job,
        handlers::jobs::fail_job,
        handlers::jobs::delete_job,
        // Secrets
        handlers::secrets::list_secrets,
        handlers::secrets::update_secrets,
        // Services
        handlers::services::list_services,
        handlers::services::create_service,
        // Permissions
        handlers::permissions::grant_permission,
        handlers::permissions::list_permissions,
        handlers::permissions::revoke_permission,
        // MCP
        handlers::mcp::list_mcp_tools,
        handlers::mcp::call_mcp_tool,
        handlers::mcp::list_mcp_servers,
        handlers::mcp::start_mcp_server,
        // Provider
        handlers::provider::get_provider_info,
    ),
    components(schemas(
        // Request types
        types::CreateSandboxRequest,
        types::RestartSpec,
        types::MountSpec,
        types::PortSpec,
        types::ResourceSpec,
        types::ExecRequest,
        types::RunRequest,
        types::EnvVar,
        types::CreateContainerRequest,
        types::ContainerMountSpec,
        types::ContainerExecRequest,
        types::StopContainerRequest,
        types::DeleteContainerRequest,
        types::PullImageRequest,
        types::CloneSandboxRequest,
        types::DiffResponse,
        types::MergeSandboxRequest,
        types::MergeStrategy,
        types::MergeResponse,
        types::DeleteQuery,
        types::LogsQuery,
        types::CreateMicrovmRequest,
        types::MicrovmExecRequest,
        types::ResizeMicrovmRequest,
        // Response types
        types::HealthResponse,
        types::SandboxInfo,
        types::MountInfo,
        types::ListSandboxesResponse,
        types::ExecResponse,
        types::ContainerInfo,
        types::ListContainersResponse,
        types::ImageInfo,
        types::ListImagesResponse,
        types::PullImageResponse,
        types::MicrovmInfo,
        types::ListMicrovmsResponse,
        types::StartResponse,
        types::StopResponse,
        types::DeleteResponse,
        types::ApiErrorResponse,
        // File types
        types::FileInfo,
        types::WriteFileRequest,
        types::ReadFileResponse,
        types::ListFilesResponse,
        types::ListFilesQuery,
        // Debug types
        types::DebugMountsResponse,
        types::DebugNetworkResponse,
        types::DnsFilterStatus,
        // Starter types
        types::StarterInfo,
        types::ListStartersResponse,
        // Snapshot types
        types::SnapshotManifest,
        types::ListSnapshotsResponse,
        types::PullSnapshotRequest,
        types::PushSnapshotResponse,
        types::UploadSnapshotQuery,
        types::UploadSnapshotResponse,
        // Stats types
        types::ResourceStatsResponse,
        types::DiskStats,
        // Job types
        types::SubmitJobRequest,
        types::SubmitJobResponse,
        types::JobInfo,
        types::JobStatus,
        types::JobsQuery,
        types::ListJobsResponse,
        types::CompleteJobRequest,
        types::FailJobRequest,
        // Secret types
        types::UpdateSecretsRequest,
        types::UpdateSecretsResponse,
        types::ListSecretsResponse,
        // Service types
        types::ServiceInfo,
        types::ListServicesResponse,
        types::CreateServiceRequest,
        // Proxy service definition
        crate::proxy::SecretService,
        // Permission / RBAC types
        types::SandboxRole,
        types::SandboxPermission,
        types::GrantPermissionRequest,
        types::ListPermissionsResponse,
        types::PermissionResponse,
        // MCP types
        types::McpServerConfig,
        types::McpToolInfo,
        types::ListMcpToolsResponse,
        types::McpServerStatus,
        types::CallMcpToolRequest,
        types::CallMcpToolResponse,
        // Provider types
        types::ProviderInfoResponse,
    ))
)]
pub struct ApiDoc;

/// Default timeout for API requests (5 minutes).
/// Most operations (start, stop, exec) complete within this time.
/// Long-running operations like image pulls may need longer, but this
/// provides a reasonable upper bound for most requests.
const API_REQUEST_TIMEOUT_SECS: u64 = 300;

/// Create the API router with all endpoints.
///
/// `cors_origins` specifies allowed CORS origins. If empty, defaults to
/// localhost:8080 and localhost:3000 (both http and 127.0.0.1 variants).
pub fn create_router(state: Arc<ApiState>, cors_origins: Vec<String>, api_token: Option<String>) -> Router {
    // Health check and metrics routes
    let health_route = Router::new()
        .route("/health", get(handlers::health::health))
        .route("/metrics", get(handlers::health::metrics));

    // Streaming routes (no timeout - run indefinitely)
    let logs_route = Router::new()
        .route("/:id/logs", get(handlers::exec::stream_logs))
        .route("/:id/exec/stream", get(handlers::exec::exec_stream))
        .route("/:id/exec/interactive", get(handlers::exec::exec_interactive));

    // Sandbox routes with timeout
    let sandbox_routes_with_timeout = Router::new()
        .route("/", post(handlers::sandboxes::create_sandbox))
        .route("/", get(handlers::sandboxes::list_sandboxes))
        .route("/:id", get(handlers::sandboxes::get_sandbox))
        .route("/:id/start", post(handlers::sandboxes::start_sandbox))
        .route("/:id/stop", post(handlers::sandboxes::stop_sandbox))
        .route("/:id", delete(handlers::sandboxes::delete_sandbox))
        // Clone and diff routes
        .route("/:id/clone", post(handlers::sandboxes::clone_sandbox))
        .route("/:id/diff/:other", get(handlers::sandboxes::diff_sandboxes))
        .route("/:id/merge/:target", post(handlers::sandboxes::merge_sandboxes))
        // Exec routes
        .route("/:id/exec", post(handlers::exec::exec_command))
        .route("/:id/run", post(handlers::exec::run_command))
        // Container routes
        .route(
            "/:id/containers",
            post(handlers::containers::create_container),
        )
        .route(
            "/:id/containers",
            get(handlers::containers::list_containers),
        )
        .route(
            "/:id/containers/:cid/start",
            post(handlers::containers::start_container),
        )
        .route(
            "/:id/containers/:cid/stop",
            post(handlers::containers::stop_container),
        )
        .route(
            "/:id/containers/:cid",
            delete(handlers::containers::delete_container),
        )
        .route(
            "/:id/containers/:cid/exec",
            post(handlers::containers::exec_in_container),
        )
        // File routes
        .route("/:id/files", get(handlers::files::list_files))
        .route("/:id/files/*path", get(handlers::files::read_file))
        .route("/:id/files/*path", put(handlers::files::write_file))
        .route("/:id/files/*path", delete(handlers::files::delete_file))
        // Multipart file upload
        .route("/:id/upload/*path", post(handlers::files::upload_file))
        // Archive (tar.gz) upload/download
        .route("/:id/archive/upload", post(handlers::files::upload_archive))
        .route("/:id/archive", get(handlers::files::download_archive))
        // Debug routes
        .route(
            "/:id/debug/mounts",
            get(handlers::sandboxes::debug_mounts),
        )
        .route(
            "/:id/debug/network",
            get(handlers::sandboxes::debug_network),
        )
        // DNS filter status
        .route("/:id/dns", get(handlers::sandboxes::dns_filter_status))
        // Snapshot push
        .route("/:id/push", post(handlers::snapshots::push_sandbox))
        // Image routes
        .route("/:id/images", get(handlers::images::list_images))
        .route("/:id/images/pull", post(handlers::images::pull_image))
        // Stats
        .route("/:id/stats", get(handlers::stats::sandbox_stats))
        // Permission routes
        .route(
            "/:id/permissions",
            post(handlers::permissions::grant_permission),
        )
        .route(
            "/:id/permissions",
            get(handlers::permissions::list_permissions),
        )
        .route(
            "/:id/permissions/:token_hash",
            delete(handlers::permissions::revoke_permission),
        )
        // MCP routes
        .route("/:id/mcp/tools", get(handlers::mcp::list_mcp_tools))
        .route("/:id/mcp/call", post(handlers::mcp::call_mcp_tool))
        .route("/:id/mcp/servers", get(handlers::mcp::list_mcp_servers))
        .route("/:id/mcp/start", post(handlers::mcp::start_mcp_server))
        // Apply timeout only to these routes
        .layer(TimeoutLayer::new(Duration::from_secs(
            API_REQUEST_TIMEOUT_SECS,
        )));

    // Combine sandbox routes (with and without timeout)
    let sandbox_routes = Router::new()
        .merge(logs_route)
        .merge(sandbox_routes_with_timeout);

    // MicroVM routes
    let microvm_routes = Router::new()
        .route("/", post(handlers::microvms::create_microvm))
        .route("/", get(handlers::microvms::list_microvms))
        .route("/:name", get(handlers::microvms::get_microvm))
        .route("/:name/start", post(handlers::microvms::start_microvm))
        .route("/:name/stop", post(handlers::microvms::stop_microvm))
        .route("/:name", delete(handlers::microvms::delete_microvm))
        .route("/:name/exec", post(handlers::microvms::exec_microvm))
        .route("/:name/resize", post(handlers::microvms::resize_microvm))
        .layer(TimeoutLayer::new(Duration::from_secs(
            API_REQUEST_TIMEOUT_SECS,
        )));

    // Snapshot streaming routes (no timeout - large file transfers can take minutes)
    let snapshot_streaming_routes = Router::new()
        .route("/:name/download", get(handlers::snapshots::download_snapshot))
        .route("/upload", post(handlers::snapshots::upload_snapshot));

    // Snapshot routes with timeout
    let snapshot_routes_with_timeout = Router::new()
        .route("/", get(handlers::snapshots::list_snapshots))
        .route("/:name/pull", post(handlers::snapshots::pull_snapshot))
        .route("/:name", delete(handlers::snapshots::delete_snapshot))
        .layer(TimeoutLayer::new(Duration::from_secs(
            API_REQUEST_TIMEOUT_SECS,
        )));

    // Combine snapshot routes (with and without timeout)
    let snapshot_routes = Router::new()
        .merge(snapshot_streaming_routes)
        .merge(snapshot_routes_with_timeout);

    // Starters route
    let starters_route = Router::new().route(
        "/",
        get(|| async {
            axum::Json(types::ListStartersResponse {
                starters: starters::list_starters(),
            })
        }),
    );

    // Secret routes
    let secret_routes = Router::new()
        .route("/", get(handlers::secrets::list_secrets))
        .route("/", put(handlers::secrets::update_secrets))
        .layer(TimeoutLayer::new(Duration::from_secs(
            API_REQUEST_TIMEOUT_SECS,
        )));

    // Service definition routes
    let service_routes = Router::new()
        .route("/", get(handlers::services::list_services))
        .route("/", post(handlers::services::create_service))
        .layer(TimeoutLayer::new(Duration::from_secs(
            API_REQUEST_TIMEOUT_SECS,
        )));

    // Job routes
    let job_routes = Router::new()
        .route("/", post(handlers::jobs::submit_job))
        .route("/", get(handlers::jobs::list_jobs))
        .route("/poll", post(handlers::jobs::poll_job))
        .route("/:id", get(handlers::jobs::get_job))
        .route("/:id", delete(handlers::jobs::delete_job))
        .route("/:id/complete", post(handlers::jobs::complete_job))
        .route("/:id/fail", post(handlers::jobs::fail_job))
        .layer(TimeoutLayer::new(Duration::from_secs(
            API_REQUEST_TIMEOUT_SECS,
        )));

    // Provider route
    let provider_route = Router::new().route(
        "/",
        get(handlers::provider::get_provider_info),
    );

    // API v1 routes
    let api_v1 = Router::new()
        .nest("/sandboxes", sandbox_routes)
        .nest("/microvms", microvm_routes)
        .nest("/snapshots", snapshot_routes)
        .nest("/starters", starters_route)
        .nest("/jobs", job_routes)
        .nest("/secrets", secret_routes)
        .nest("/services", service_routes)
        .nest("/provider", provider_route);

    // Apply bearer token auth middleware if configured
    let api_v1 = if let Some(ref token) = api_token {
        let token = token.clone();
        api_v1.layer(axum::middleware::from_fn(move |req, next| {
            let token = token.clone();
            async move { auth::require_bearer_token(req, next, token).await }
        }))
    } else {
        api_v1
    };

    // CORS: Use configured origins, or default to localhost for security.
    let default_origins = || {
        vec![
            "http://localhost:8080"
                .parse()
                .expect("hardcoded CORS origin"),
            "http://127.0.0.1:8080"
                .parse()
                .expect("hardcoded CORS origin"),
            "http://localhost:3000"
                .parse()
                .expect("hardcoded CORS origin"),
            "http://127.0.0.1:3000"
                .parse()
                .expect("hardcoded CORS origin"),
        ]
    };
    let origins: Vec<axum::http::HeaderValue> = if cors_origins.is_empty() {
        default_origins()
    } else {
        let mut valid = Vec::new();
        for origin in &cors_origins {
            match origin.parse() {
                Ok(v) => valid.push(v),
                Err(e) => {
                    tracing::warn!(origin = %origin, error = %e, "invalid CORS origin, skipping");
                }
            }
        }
        if valid.is_empty() {
            tracing::warn!("no valid CORS origins provided, falling back to defaults");
            default_origins()
        } else {
            valid
        }
    };

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
        ])
        .allow_headers([axum::http::header::CONTENT_TYPE, axum::http::header::AUTHORIZATION]);

    // Request ID middleware: generates a unique ID per request for correlation.
    // Clients can also send X-Request-Id header to propagate their own ID.
    let request_id_layer = axum::middleware::from_fn(request_id_middleware);

    // Combine all routes
    Router::new()
        .merge(health_route)
        .nest("/api/v1", api_v1)
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .layer(request_id_layer)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

/// Middleware that adds a unique request ID to each request for correlation.
/// If the client sends an `X-Request-Id` header, that value is used; otherwise
/// a new UUID is generated. The ID is added to the response headers and logged.
async fn request_id_middleware(
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let request_id = req
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let method = req.method().clone();
    let uri = req.uri().path().to_string();

    tracing::info!(
        request_id = %request_id,
        method = %method,
        path = %uri,
        "request started"
    );

    let start = std::time::Instant::now();
    let mut response = next.run(req).await;

    let elapsed = start.elapsed();
    tracing::info!(
        request_id = %request_id,
        status = %response.status().as_u16(),
        duration_ms = %elapsed.as_millis(),
        "request completed"
    );

    if let Ok(val) = axum::http::HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", val);
    }

    response
}
