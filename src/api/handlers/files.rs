//! File CRUD handlers.
//!
//! Provides REST endpoints for reading, writing, listing, and deleting
//! files inside a sandbox. Operations go through the exec channel using
//! base64 encoding, matching the pattern used by the SDK's file methods
//! but at the server level for better performance and API cleanliness.

use axum::{
    body::Bytes,
    extract::{Multipart, Path, Query, State},
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::sync::Arc;
use std::time::Duration;

use crate::api::auth::{check_permission, extract_bearer_token};
use crate::api::error::{classify_ensure_running_error, ApiError};
use crate::api::state::{ensure_running_and_persist, with_sandbox_client, ApiState};
use crate::api::types::{
    ApiErrorResponse, FileInfo, ListFilesQuery, ListFilesResponse, ReadFileResponse,
    MachineRole, WriteFileRequest,
};

/// Validate a file path — must be absolute and contain no `..` traversal.
fn validate_path(path: &str) -> Result<(), ApiError> {
    if !path.starts_with('/') {
        return Err(ApiError::BadRequest("path must be absolute".into()));
    }
    if path.contains("..") {
        return Err(ApiError::BadRequest(
            "path must not contain '..' traversal".into(),
        ));
    }
    Ok(())
}

/// Read a file from a sandbox.
///
/// Returns the file content as base64-encoded data.
#[utoipa::path(
    get,
    path = "/api/v1/machines/{id}/files/{path}",
    tag = "Files",
    params(
        ("id" = String, Path, description = "Machine name"),
        ("path" = String, Path, description = "File path (absolute)")
    ),
    responses(
        (status = 200, description = "File content", body = ReadFileResponse),
        (status = 404, description = "File or sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Read failed", body = ApiErrorResponse)
    )
)]
pub async fn read_file(
    State(state): State<Arc<ApiState>>,
    Path((id, file_path)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ReadFileResponse>, ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, MachineRole::ReadOnly)?;
    }
    let file_path = format!("/{}", file_path);
    validate_path(&file_path)?;

    let entry = state.get_machine(&id)?;
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    let escaped_path = file_path.replace('\'', "'\\''");

    // Get file size first to decide strategy.
    // The agent protocol has a ~64KB stdout buffer limit, so files whose
    // base64 encoding exceeds ~48KB (i.e. raw files >~36KB) must be read
    // in chunks via dd + base64 to avoid hanging.
    let size_cmd = vec![
        "sh".into(),
        "-c".into(),
        format!("stat -c %s '{}' 2>/dev/null || stat -f %z '{}'", escaped_path, escaped_path),
    ];
    let (exit_code, size_stdout, stderr) =
        with_sandbox_client(&entry, move |c| {
            c.vm_exec(size_cmd, vec![], None, Some(Duration::from_secs(5)))
        })
        .await?;

    if exit_code != 0 {
        return Err(ApiError::NotFound(format!(
            "file '{}': {}",
            file_path,
            stderr.trim()
        )));
    }

    let file_size: u64 = size_stdout
        .trim()
        .parse()
        .unwrap_or(0);

    // Small files (<36KB): single base64 command (output < 48KB, well within agent buffer)
    let chunk_threshold: u64 = 36 * 1024;

    if file_size <= chunk_threshold {
        let cmd = vec![
            "sh".into(),
            "-c".into(),
            format!("base64 -w 0 '{}'", escaped_path),
        ];
        let (exit_code, stdout, stderr) =
            with_sandbox_client(&entry, move |c| {
                c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(30)))
            })
            .await?;

        if exit_code != 0 {
            return Err(ApiError::NotFound(format!(
                "file '{}': {}",
                file_path,
                stderr.trim()
            )));
        }

        Ok(Json(ReadFileResponse {
            content: stdout.trim().to_string(),
        }))
    } else {
        // Large files: read in 32KB chunks via dd, base64 each chunk,
        // then reassemble on the server side.
        let chunk_size: u64 = 32 * 1024;
        let num_chunks = file_size.div_ceil(chunk_size);
        let mut b64_parts: Vec<String> = Vec::new();

        for i in 0..num_chunks {
            let skip = i * chunk_size;
            let cmd = vec![
                "sh".into(),
                "-c".into(),
                format!(
                    "dd if='{}' bs=1 skip={} count={} 2>/dev/null | base64 -w 0",
                    escaped_path, skip, chunk_size
                ),
            ];
            let (exit_code, stdout, stderr) =
                with_sandbox_client(&entry, move |c| {
                    c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(30)))
                })
                .await?;

            if exit_code != 0 {
                return Err(ApiError::Internal(format!(
                    "read_file chunk {} failed: {}",
                    i,
                    stderr.trim()
                )));
            }

            b64_parts.push(stdout.trim().to_string());
        }

        // Decode each chunk and re-encode as a single base64 string
        let mut raw_bytes: Vec<u8> = Vec::with_capacity(file_size as usize);
        for (i, part) in b64_parts.iter().enumerate() {
            let decoded = BASE64.decode(part).map_err(|e| {
                ApiError::Internal(format!("failed to decode chunk {}: {}", i, e))
            })?;
            raw_bytes.extend_from_slice(&decoded);
        }
        let content = BASE64.encode(&raw_bytes);

        Ok(Json(ReadFileResponse { content }))
    }
}

/// Write a file to a sandbox.
///
/// The content must be base64-encoded.
#[utoipa::path(
    put,
    path = "/api/v1/machines/{id}/files/{path}",
    tag = "Files",
    params(
        ("id" = String, Path, description = "Machine name"),
        ("path" = String, Path, description = "File path (absolute)")
    ),
    request_body = WriteFileRequest,
    responses(
        (status = 200, description = "File written"),
        (status = 400, description = "Invalid request", body = ApiErrorResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse),
        (status = 500, description = "Write failed", body = ApiErrorResponse)
    )
)]
pub async fn write_file(
    State(state): State<Arc<ApiState>>,
    Path((id, file_path)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
    Json(req): Json<WriteFileRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, MachineRole::Operator)?;
    }
    let file_path = format!("/{}", file_path);
    validate_path(&file_path)?;

    // Validate base64
    BASE64
        .decode(&req.content)
        .map_err(|e| ApiError::BadRequest(format!("invalid base64 content: {}", e)))?;

    let entry = state.get_machine(&id)?;
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    // Ensure parent directory exists
    let escaped_path = file_path.replace('\'', "'\\''");
    if let Some(last_slash) = file_path.rfind('/') {
        if last_slash > 0 {
            let parent = &file_path[..last_slash];
            let mkdir_cmd = vec![
                "sh".into(),
                "-c".into(),
                format!("mkdir -p '{}'", parent.replace('\'', "'\\''")),
            ];
            let _ = with_sandbox_client(&entry, move |c| {
                c.vm_exec(mkdir_cmd, vec![], None, Some(Duration::from_secs(10)))
            })
            .await;
        }
    }

    // Write file via base64 decode.
    // For small content (<48KB base64), use a single command.
    // For larger content, chunk to avoid ARG_MAX limits.
    let chunk_limit = 48 * 1024;

    if req.content.len() <= chunk_limit {
        let mut script = format!(
            "echo '{}' | base64 -d > '{}'",
            req.content, escaped_path
        );
        if let Some(ref perms) = req.permissions {
            script.push_str(&format!(" && chmod {} '{}'", perms, escaped_path));
        }
        let cmd = vec!["sh".into(), "-c".into(), script];
        let (exit_code, _stdout, stderr) =
            with_sandbox_client(&entry, move |c| {
                c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(30)))
            })
            .await?;
        if exit_code != 0 {
            return Err(ApiError::Internal(format!(
                "write_file failed: {}",
                stderr.trim()
            )));
        }
    } else {
        // Large content — write base64 chunks to temp file, then decode
        let chunks: Vec<&str> = req
            .content
            .as_bytes()
            .chunks(chunk_limit)
            .map(|c| std::str::from_utf8(c).unwrap_or_default())
            .collect();

        for (i, chunk) in chunks.iter().enumerate() {
            let redirect = if i == 0 { ">" } else { ">>" };
            let script = format!("echo -n '{}' {} /tmp/_smolvm_write.b64", chunk, redirect);
            let cmd = vec!["sh".into(), "-c".into(), script];
            let (exit_code, _, stderr) =
                with_sandbox_client(&entry, move |c| {
                    c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(30)))
                })
                .await?;
            if exit_code != 0 {
                let cleanup = vec!["sh".into(), "-c".into(), "rm -f /tmp/_smolvm_write.b64".into()];
                let _ = with_sandbox_client(&entry, move |c| {
                    c.vm_exec(cleanup, vec![], None, Some(Duration::from_secs(5)))
                })
                .await;
                return Err(ApiError::Internal(format!(
                    "write_file chunk {}/{} failed: {}",
                    i + 1,
                    chunks.len(),
                    stderr.trim()
                )));
            }
        }

        let mut decode_script = format!(
            "base64 -d < /tmp/_smolvm_write.b64 > '{}' && rm -f /tmp/_smolvm_write.b64",
            escaped_path
        );
        if let Some(ref perms) = req.permissions {
            decode_script = format!(
                "base64 -d < /tmp/_smolvm_write.b64 > '{}' && chmod {} '{}' && rm -f /tmp/_smolvm_write.b64",
                escaped_path, perms, escaped_path
            );
        }
        let cmd = vec!["sh".into(), "-c".into(), decode_script];
        let (exit_code, _, stderr) =
            with_sandbox_client(&entry, move |c| {
                c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(30)))
            })
            .await?;
        if exit_code != 0 {
            let cleanup = vec!["sh".into(), "-c".into(), "rm -f /tmp/_smolvm_write.b64".into()];
            let _ = with_sandbox_client(&entry, move |c| {
                c.vm_exec(cleanup, vec![], None, Some(Duration::from_secs(5)))
            })
            .await;
            return Err(ApiError::Internal(format!(
                "write_file failed: {}",
                stderr.trim()
            )));
        }
    }

    Ok(Json(serde_json::json!({ "written": file_path })))
}

/// Delete a file from a sandbox.
#[utoipa::path(
    delete,
    path = "/api/v1/machines/{id}/files/{path}",
    tag = "Files",
    params(
        ("id" = String, Path, description = "Machine name"),
        ("path" = String, Path, description = "File path (absolute)")
    ),
    responses(
        (status = 200, description = "File deleted"),
        (status = 404, description = "File or sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Delete failed", body = ApiErrorResponse)
    )
)]
pub async fn delete_file(
    State(state): State<Arc<ApiState>>,
    Path((id, file_path)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, MachineRole::Operator)?;
    }
    let file_path = format!("/{}", file_path);
    validate_path(&file_path)?;

    let entry = state.get_machine(&id)?;
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    let cmd = vec![
        "sh".into(),
        "-c".into(),
        format!("rm -f '{}'", file_path.replace('\'', "'\\''")),
    ];
    let timeout = Some(Duration::from_secs(10));

    let (exit_code, _stdout, stderr) =
        with_sandbox_client(&entry, move |c| c.vm_exec(cmd, vec![], None, timeout)).await?;

    if exit_code != 0 {
        return Err(ApiError::Internal(format!(
            "delete_file failed: {}",
            stderr.trim()
        )));
    }

    Ok(Json(serde_json::json!({ "deleted": file_path })))
}

/// List files in a directory.
#[utoipa::path(
    get,
    path = "/api/v1/machines/{id}/files",
    tag = "Files",
    params(
        ("id" = String, Path, description = "Machine name"),
        ("dir" = String, Query, description = "Directory to list (default: /)")
    ),
    responses(
        (status = 200, description = "File listing", body = ListFilesResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse),
        (status = 500, description = "Listing failed", body = ApiErrorResponse)
    )
)]
pub async fn list_files(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ListFilesQuery>,
) -> Result<Json<ListFilesResponse>, ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, MachineRole::ReadOnly)?;
    }
    validate_path(&query.dir)?;

    let entry = state.get_machine(&id)?;
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    // Use stat to get detailed file info
    let escaped_dir = query.dir.replace('\'', "'\\''");
    let cmd = vec![
        "sh".into(),
        "-c".into(),
        format!(
            "ls -1a '{}' 2>/dev/null | while read f; do \
             [ \"$f\" = \".\" ] || [ \"$f\" = \"..\" ] && continue; \
             stat -c '%s %a %F %n' \"{}/\"\"$f\" 2>/dev/null || \
             echo \"0 644 regular file $f\"; \
             done",
            escaped_dir, escaped_dir
        ),
    ];
    let timeout = Some(Duration::from_secs(15));

    let (exit_code, stdout, _stderr) =
        with_sandbox_client(&entry, move |c| c.vm_exec(cmd, vec![], None, timeout)).await?;

    if exit_code != 0 {
        // Directory might not exist or be empty — return empty list
        return Ok(Json(ListFilesResponse {
            directory: query.dir,
            files: vec![],
        }));
    }

    let files: Vec<FileInfo> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            // Format: "size perms type name"
            let parts: Vec<&str> = line.splitn(4, ' ').collect();
            if parts.len() < 4 {
                return None;
            }
            let size: u64 = parts[0].parse().unwrap_or(0);
            let permissions = parts[1].to_string();
            let is_dir = parts[2] == "directory";
            let name = parts[3].to_string();
            let path = if query.dir == "/" {
                format!("/{}", name)
            } else {
                format!("{}/{}", query.dir, name)
            };
            Some(FileInfo {
                path,
                name,
                size,
                is_dir,
                permissions,
            })
        })
        .collect();

    Ok(Json(ListFilesResponse {
        directory: query.dir,
        files,
    }))
}

/// Upload a file via multipart/form-data.
///
/// Accepts binary file content directly without base64 encoding.
/// Suitable for large files.
#[utoipa::path(
    post,
    path = "/api/v1/machines/{id}/upload/{path}",
    tag = "Files",
    params(
        ("id" = String, Path, description = "Machine name"),
        ("path" = String, Path, description = "File path (absolute)")
    ),
    responses(
        (status = 200, description = "File uploaded"),
        (status = 400, description = "Invalid request", body = ApiErrorResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse),
        (status = 500, description = "Upload failed", body = ApiErrorResponse)
    )
)]
pub async fn upload_file(
    State(state): State<Arc<ApiState>>,
    Path((id, file_path)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, MachineRole::Operator)?;
    }
    let file_path = format!("/{}", file_path);
    validate_path(&file_path)?;

    let entry = state.get_machine(&id)?;
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    // Extract file content from multipart form
    let mut file_data: Option<Bytes> = None;
    let mut permissions: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("multipart error: {}", e)))?
    {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "file" => {
                file_data = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| ApiError::BadRequest(format!("failed to read file: {}", e)))?,
                );
            }
            "permissions" => {
                permissions = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| ApiError::BadRequest(format!("failed to read permissions: {}", e)))?,
                );
            }
            _ => {}
        }
    }

    let data = file_data.ok_or_else(|| ApiError::BadRequest("missing 'file' field".into()))?;

    // Ensure parent directory exists
    let escaped_path = file_path.replace('\'', "'\\''");
    if let Some(last_slash) = file_path.rfind('/') {
        if last_slash > 0 {
            let parent = &file_path[..last_slash];
            let mkdir_cmd = vec![
                "sh".into(),
                "-c".into(),
                format!("mkdir -p '{}'", parent.replace('\'', "'\\''")),
            ];
            let _ = with_sandbox_client(&entry, move |c| {
                c.vm_exec(mkdir_cmd, vec![], None, Some(Duration::from_secs(10)))
            })
            .await;
        }
    }

    // Write file in chunks to handle large files
    // For files under 512KB, write in a single command
    let b64_content = BASE64.encode(&data);
    let chunk_size = 512 * 1024; // 512KB base64 chunks

    if b64_content.len() <= chunk_size {
        let mut script = format!(
            "echo '{}' | base64 -d > '{}'",
            b64_content, escaped_path
        );
        if let Some(ref perms) = permissions {
            script.push_str(&format!(" && chmod {} '{}'", perms, escaped_path));
        }
        let cmd = vec!["sh".into(), "-c".into(), script];
        let (exit_code, _, stderr) =
            with_sandbox_client(&entry, move |c| {
                c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(60)))
            })
            .await?;
        if exit_code != 0 {
            return Err(ApiError::Internal(format!("upload failed: {}", stderr.trim())));
        }
    } else {
        // For larger files, write in chunks using append
        let chunks: Vec<&str> = b64_content
            .as_bytes()
            .chunks(chunk_size)
            .map(|c| std::str::from_utf8(c).unwrap_or_default())
            .collect();

        for (i, chunk) in chunks.iter().enumerate() {
            let redirect = if i == 0 { ">" } else { ">>" };
            let script = format!(
                "echo '{}' | base64 -d {} '{}'",
                chunk, redirect, escaped_path
            );
            let cmd = vec!["sh".into(), "-c".into(), script];
            let (exit_code, _, stderr) =
                with_sandbox_client(&entry, move |c| {
                    c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(60)))
                })
                .await?;
            if exit_code != 0 {
                return Err(ApiError::Internal(format!(
                    "upload chunk {}/{} failed: {}",
                    i + 1,
                    chunks.len(),
                    stderr.trim()
                )));
            }
        }

        // Set permissions after all chunks are written
        if let Some(ref perms) = permissions {
            let cmd = vec![
                "sh".into(),
                "-c".into(),
                format!("chmod {} '{}'", perms, escaped_path),
            ];
            let _ = with_sandbox_client(&entry, move |c| {
                c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(10)))
            })
            .await;
        }
    }

    Ok(Json(serde_json::json!({
        "uploaded": file_path,
        "size": data.len()
    })))
}

/// Upload a tar.gz archive and extract it in a sandbox directory.
///
/// The request body should be the raw tar.gz bytes (Content-Type: application/gzip).
#[utoipa::path(
    post,
    path = "/api/v1/machines/{id}/archive/upload",
    tag = "Files",
    params(
        ("id" = String, Path, description = "Machine name"),
        ("dir" = Option<String>, Query, description = "Directory to extract to (default: /)")
    ),
    request_body(content_type = "application/gzip", content = Vec<u8>, description = "Raw tar.gz archive bytes"),
    responses(
        (status = 200, description = "Archive extracted"),
        (status = 400, description = "Invalid request", body = ApiErrorResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse),
        (status = 500, description = "Extract failed", body = ApiErrorResponse)
    )
)]
pub async fn upload_archive(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ArchiveQuery>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, MachineRole::Operator)?;
    }
    let dir = query.dir.as_deref().unwrap_or("/");
    validate_path(dir)?;

    if body.is_empty() {
        return Err(ApiError::BadRequest("empty archive body".into()));
    }

    let entry = state.get_machine(&id)?;
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    // Ensure target directory exists
    let escaped_dir = dir.replace('\'', "'\\''");
    let mkdir_cmd = vec![
        "sh".into(),
        "-c".into(),
        format!("mkdir -p '{}'", escaped_dir),
    ];
    let _ = with_sandbox_client(&entry, move |c| {
        c.vm_exec(mkdir_cmd, vec![], None, Some(Duration::from_secs(10)))
    })
    .await;

    // Send archive as base64 in chunks to avoid ARG_MAX limits.
    // For small archives (<48KB), a single command suffices. For larger ones,
    // we write base64 chunks to a temp file, then decode+extract.
    let b64_content = BASE64.encode(&body);
    let chunk_limit = 48 * 1024; // 48KB base64 ≈ 36KB binary, well under ARG_MAX

    if b64_content.len() <= chunk_limit {
        // Small archive — single command
        let script = format!(
            "echo '{}' | base64 -d | tar xzf - -C '{}'",
            b64_content, escaped_dir
        );
        let cmd = vec!["sh".into(), "-c".into(), script];
        let (exit_code, _, stderr) =
            with_sandbox_client(&entry, move |c| {
                c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(120)))
            })
            .await?;

        if exit_code != 0 {
            return Err(ApiError::Internal(format!(
                "archive extraction failed: {}",
                stderr.trim()
            )));
        }
    } else {
        // Large archive — write base64 chunks to temp file, then decode+extract
        let chunks: Vec<&str> = b64_content
            .as_bytes()
            .chunks(chunk_limit)
            .map(|c| std::str::from_utf8(c).unwrap_or_default())
            .collect();

        for (i, chunk) in chunks.iter().enumerate() {
            let redirect = if i == 0 { ">" } else { ">>" };
            let script = format!("echo -n '{}' {} /tmp/_smolvm_upload.b64", chunk, redirect);
            let cmd = vec!["sh".into(), "-c".into(), script];
            let (exit_code, _, stderr) =
                with_sandbox_client(&entry, move |c| {
                    c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(30)))
                })
                .await?;

            if exit_code != 0 {
                // Clean up temp file on failure
                let cleanup = vec!["sh".into(), "-c".into(), "rm -f /tmp/_smolvm_upload.b64".into()];
                let _ = with_sandbox_client(&entry, move |c| {
                    c.vm_exec(cleanup, vec![], None, Some(Duration::from_secs(5)))
                })
                .await;
                return Err(ApiError::Internal(format!(
                    "archive upload chunk {}/{} failed: {}",
                    i + 1,
                    chunks.len(),
                    stderr.trim()
                )));
            }
        }

        // Decode temp file and extract
        let extract_script = format!(
            "base64 -d < /tmp/_smolvm_upload.b64 | tar xzf - -C '{}' && rm -f /tmp/_smolvm_upload.b64",
            escaped_dir
        );
        let cmd = vec!["sh".into(), "-c".into(), extract_script];
        let (exit_code, _, stderr) =
            with_sandbox_client(&entry, move |c| {
                c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(120)))
            })
            .await?;

        if exit_code != 0 {
            // Clean up temp file on failure
            let cleanup = vec!["sh".into(), "-c".into(), "rm -f /tmp/_smolvm_upload.b64".into()];
            let _ = with_sandbox_client(&entry, move |c| {
                c.vm_exec(cleanup, vec![], None, Some(Duration::from_secs(5)))
            })
            .await;
            return Err(ApiError::Internal(format!(
                "archive extraction failed: {}",
                stderr.trim()
            )));
        }
    }

    Ok(Json(serde_json::json!({
        "extracted_to": dir,
        "archive_size": body.len()
    })))
}

/// Download a directory as a tar.gz archive.
///
/// Returns the raw tar.gz bytes.
#[utoipa::path(
    get,
    path = "/api/v1/machines/{id}/archive",
    tag = "Files",
    params(
        ("id" = String, Path, description = "Machine name"),
        ("dir" = Option<String>, Query, description = "Directory to archive (default: /)")
    ),
    responses(
        (status = 200, description = "Archive content (application/gzip)"),
        (status = 404, description = "Machine or directory not found", body = ApiErrorResponse),
        (status = 500, description = "Archive failed", body = ApiErrorResponse)
    )
)]
pub async fn download_archive(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ArchiveQuery>,
) -> Result<(axum::http::HeaderMap, Bytes), ApiError> {
    if let Some(token) = extract_bearer_token(&headers) {
        check_permission(&state, &id, &token, MachineRole::ReadOnly)?;
    }
    let dir = query.dir.as_deref().unwrap_or("/");
    validate_path(dir)?;

    let entry = state.get_machine(&id)?;
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    // Create tar.gz in-guest, write to temp file, then download in chunks.
    // Direct piping (tar | base64) hangs for archives >~48KB due to agent
    // protocol stdout buffer limits (~64KB). Instead: tar to a file, get
    // its size, then read chunks via dd + base64.
    let escaped_dir = dir.replace('\'', "'\\''");
    let tar_cmd = vec![
        "sh".into(),
        "-c".into(),
        format!(
            "tar czf /tmp/_smolvm_dl.tar.gz -C '{}' . 2>/dev/null && stat -c %s /tmp/_smolvm_dl.tar.gz 2>/dev/null || stat -f %z /tmp/_smolvm_dl.tar.gz",
            escaped_dir
        ),
    ];
    let (exit_code, size_stdout, stderr) =
        with_sandbox_client(&entry, move |c| {
            c.vm_exec(tar_cmd, vec![], None, Some(Duration::from_secs(120)))
        })
        .await?;

    if exit_code != 0 {
        return Err(ApiError::Internal(format!(
            "archive creation failed: {}",
            stderr.trim()
        )));
    }

    let archive_size: u64 = size_stdout.trim().parse().unwrap_or(0);
    if archive_size == 0 {
        // Clean up and return error
        let cleanup = vec!["sh".into(), "-c".into(), "rm -f /tmp/_smolvm_dl.tar.gz".into()];
        let _ = with_sandbox_client(&entry, move |c| {
            c.vm_exec(cleanup, vec![], None, Some(Duration::from_secs(5)))
        })
        .await;
        return Err(ApiError::Internal("archive is empty".into()));
    }

    // Read archive in 32KB chunks
    let chunk_size: u64 = 32 * 1024;
    let num_chunks = archive_size.div_ceil(chunk_size);
    let mut archive_bytes: Vec<u8> = Vec::with_capacity(archive_size as usize);

    for i in 0..num_chunks {
        let skip = i * chunk_size;
        let cmd = vec![
            "sh".into(),
            "-c".into(),
            format!(
                "dd if=/tmp/_smolvm_dl.tar.gz bs=1 skip={} count={} 2>/dev/null | base64 -w 0",
                skip, chunk_size
            ),
        ];
        let (exit_code, stdout, stderr) =
            with_sandbox_client(&entry, move |c| {
                c.vm_exec(cmd, vec![], None, Some(Duration::from_secs(30)))
            })
            .await?;

        if exit_code != 0 {
            let cleanup = vec!["sh".into(), "-c".into(), "rm -f /tmp/_smolvm_dl.tar.gz".into()];
            let _ = with_sandbox_client(&entry, move |c| {
                c.vm_exec(cleanup, vec![], None, Some(Duration::from_secs(5)))
            })
            .await;
            return Err(ApiError::Internal(format!(
                "archive read chunk {} failed: {}",
                i,
                stderr.trim()
            )));
        }

        let decoded = BASE64.decode(stdout.trim()).map_err(|e| {
            ApiError::Internal(format!("failed to decode archive chunk {}: {}", i, e))
        })?;
        archive_bytes.extend_from_slice(&decoded);
    }

    // Clean up temp file
    let cleanup = vec!["sh".into(), "-c".into(), "rm -f /tmp/_smolvm_dl.tar.gz".into()];
    let _ = with_sandbox_client(&entry, move |c| {
        c.vm_exec(cleanup, vec![], None, Some(Duration::from_secs(5)))
    })
    .await;

    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        "application/gzip".parse().unwrap(),
    );
    headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{}.tar.gz\"", id)
            .parse()
            .unwrap(),
    );

    Ok((headers, Bytes::from(archive_bytes)))
}

/// Query parameters for archive operations.
#[derive(Debug, serde::Deserialize)]
pub struct ArchiveQuery {
    /// Directory to extract to (upload) or archive from (download).
    pub dir: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_path_absolute() {
        assert!(validate_path("/app/test.txt").is_ok());
        assert!(validate_path("/").is_ok());
    }

    #[test]
    fn test_validate_path_relative() {
        assert!(validate_path("relative/path").is_err());
    }

    #[test]
    fn test_validate_path_traversal() {
        assert!(validate_path("/app/../etc/passwd").is_err());
        assert!(validate_path("/app/..").is_err());
    }

    #[test]
    fn test_validate_path_normal_dots() {
        // Single dots are fine
        assert!(validate_path("/app/.hidden").is_ok());
        assert!(validate_path("/app/file.txt").is_ok());
    }
}
