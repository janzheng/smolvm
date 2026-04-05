//! Work queue / job dispatch handlers.
//!
//! Provides a simple in-memory job queue for decoupling work submission
//! from execution. Agents poll for work instead of being exec'd into.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::api::error::ApiError;
use crate::api::state::ApiState;
use crate::api::types::{
    ApiErrorResponse, CompleteJobRequest, ExecResponse, FailJobRequest, JobInfo, JobStatus,
    JobsQuery, ListJobsResponse, SubmitJobRequest, SubmitJobResponse,
};

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Submit a new job to the work queue.
#[utoipa::path(
    post,
    path = "/api/v1/jobs",
    tag = "Jobs",
    request_body = SubmitJobRequest,
    responses(
        (status = 201, description = "Job submitted", body = SubmitJobResponse),
        (status = 400, description = "Invalid request", body = ApiErrorResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse)
    )
)]
pub async fn submit_job(
    State(state): State<Arc<ApiState>>,
    Json(req): Json<SubmitJobRequest>,
) -> Result<(axum::http::StatusCode, Json<SubmitJobResponse>), ApiError> {
    // Validate machine exists
    if !state.machine_exists(&req.machine) {
        return Err(ApiError::NotFound(format!(
            "machine '{}' not found",
            req.machine
        )));
    }

    if req.command.is_empty() {
        return Err(ApiError::BadRequest("command cannot be empty".into()));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let job = JobInfo {
        id: id.clone(),
        machine: req.machine,
        command: req.command,
        env: req.env,
        workdir: req.workdir,
        timeout_secs: req.timeout_secs.unwrap_or(300),
        status: JobStatus::Queued,
        max_retries: req.max_retries.unwrap_or(0),
        attempts: 0,
        priority: req.priority,
        labels: req.labels,
        created_at: now_secs(),
        started_at: None,
        completed_at: None,
        result: None,
        error: None,
    };

    state.add_job(job);
    tracing::info!(job_id = %id, "job submitted");

    Ok((
        axum::http::StatusCode::CREATED,
        Json(SubmitJobResponse {
            id,
            status: JobStatus::Queued,
        }),
    ))
}

/// List jobs with optional filters.
#[utoipa::path(
    get,
    path = "/api/v1/jobs",
    tag = "Jobs",
    params(JobsQuery),
    responses(
        (status = 200, description = "Job list", body = ListJobsResponse)
    )
)]
pub async fn list_jobs(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<JobsQuery>,
) -> Json<ListJobsResponse> {
    let jobs = state.list_jobs(query.status.as_deref(), query.machine.as_deref(), query.limit);
    Json(ListJobsResponse { jobs })
}

/// Get a specific job by ID.
#[utoipa::path(
    get,
    path = "/api/v1/jobs/{id}",
    tag = "Jobs",
    params(
        ("id" = String, Path, description = "Job ID")
    ),
    responses(
        (status = 200, description = "Job details", body = JobInfo),
        (status = 404, description = "Job not found", body = ApiErrorResponse)
    )
)]
pub async fn get_job(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
) -> Result<Json<JobInfo>, ApiError> {
    state
        .get_job(&id)
        .map(Json)
        .ok_or_else(|| ApiError::NotFound(format!("job '{}' not found", id)))
}

/// Poll for the next available job (claim it atomically).
/// Returns the highest-priority queued job, transitions it to "running".
#[utoipa::path(
    post,
    path = "/api/v1/jobs/poll",
    tag = "Jobs",
    responses(
        (status = 200, description = "Claimed job", body = JobInfo),
        (status = 204, description = "No jobs available")
    )
)]
pub async fn poll_job(
    State(state): State<Arc<ApiState>>,
) -> Result<Json<JobInfo>, axum::http::StatusCode> {
    match state.poll_next_job() {
        Some(job) => {
            tracing::info!(job_id = %job.id, machine = %job.machine, "job claimed");
            Ok(Json(job))
        }
        None => Err(axum::http::StatusCode::NO_CONTENT),
    }
}

/// Mark a job as completed with its result.
#[utoipa::path(
    post,
    path = "/api/v1/jobs/{id}/complete",
    tag = "Jobs",
    params(
        ("id" = String, Path, description = "Job ID")
    ),
    request_body = CompleteJobRequest,
    responses(
        (status = 200, description = "Job completed", body = JobInfo),
        (status = 404, description = "Job not found", body = ApiErrorResponse)
    )
)]
pub async fn complete_job(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    Json(req): Json<CompleteJobRequest>,
) -> Result<Json<JobInfo>, ApiError> {
    let result = ExecResponse {
        exit_code: req.exit_code,
        stdout: req.stdout,
        stderr: req.stderr,
    };
    state
        .complete_job(&id, result)
        .map(Json)
        .ok_or_else(|| ApiError::NotFound(format!("job '{}' not found", id)))
}

/// Mark a job as failed. If retries remain, re-queues it; otherwise marks as dead.
#[utoipa::path(
    post,
    path = "/api/v1/jobs/{id}/fail",
    tag = "Jobs",
    params(
        ("id" = String, Path, description = "Job ID")
    ),
    request_body = FailJobRequest,
    responses(
        (status = 200, description = "Job failed/requeued", body = JobInfo),
        (status = 404, description = "Job not found", body = ApiErrorResponse)
    )
)]
pub async fn fail_job(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    Json(req): Json<FailJobRequest>,
) -> Result<Json<JobInfo>, ApiError> {
    state
        .fail_job(&id, &req.error)
        .map(Json)
        .ok_or_else(|| ApiError::NotFound(format!("job '{}' not found", id)))
}

/// Delete a job from the queue.
#[utoipa::path(
    delete,
    path = "/api/v1/jobs/{id}",
    tag = "Jobs",
    params(
        ("id" = String, Path, description = "Job ID")
    ),
    responses(
        (status = 200, description = "Job deleted"),
        (status = 404, description = "Job not found", body = ApiErrorResponse)
    )
)]
pub async fn delete_job(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
) -> Result<axum::http::StatusCode, ApiError> {
    if state.remove_job(&id) {
        Ok(axum::http::StatusCode::OK)
    } else {
        Err(ApiError::NotFound(format!("job '{}' not found", id)))
    }
}
