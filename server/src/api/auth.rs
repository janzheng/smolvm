//! Bearer token authentication middleware and RBAC permission checking.

use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::api::error::ApiError;
use crate::api::state::ApiState;
use crate::api::types::SandboxRole;

#[derive(Serialize)]
struct AuthErrorResponse {
    error: String,
    code: &'static str,
}

/// Axum middleware that validates Bearer token authentication.
///
/// Extracts the `Authorization: Bearer <token>` header and compares
/// it against the configured API token using constant-time comparison.
pub async fn require_bearer_token(req: Request, next: Next, expected_token: String) -> Response {
    let auth_header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    match auth_header {
        Some(value) if value.starts_with("Bearer ") => {
            let provided = &value[7..];
            if constant_time_eq(provided.as_bytes(), expected_token.as_bytes()) {
                next.run(req).await
            } else {
                unauthorized("invalid bearer token")
            }
        }
        Some(_) => unauthorized("authorization header must use Bearer scheme"),
        None => unauthorized("missing Authorization header"),
    }
}

fn unauthorized(message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(AuthErrorResponse {
            error: message.to_string(),
            code: "UNAUTHORIZED",
        }),
    )
        .into_response()
}

/// Constant-time byte comparison to prevent timing attacks.
/// Returns true iff both slices have identical length and content.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Generate a random 32-byte hex token (64 hex chars) using /dev/urandom.
pub fn generate_token() -> std::io::Result<String> {
    use std::io::Read;
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{:02x}", b)).collect())
}

/// Hash a bearer token to a 16-character hex string for storage.
///
/// Uses `DefaultHasher` (SipHash) for fast, non-cryptographic hashing.
/// This is sufficient for RBAC token matching — the tokens themselves
/// are already checked by the bearer auth middleware.
pub fn hash_token(token: &str) -> String {
    let mut hasher = DefaultHasher::new();
    token.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Extract the bearer token from an axum request's headers.
///
/// Returns `None` if no Authorization header is present or it's not Bearer scheme.
pub fn extract_bearer_token(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

/// Check whether the given token has at least the `required` role on a sandbox.
///
/// **Backwards compatible**: if the sandbox has no `owner_token_hash` set
/// (i.e., it was created before RBAC was added, or auth is disabled),
/// all requests are allowed.
///
/// Role hierarchy: Owner > Operator > ReadOnly
pub fn check_permission(
    state: &ApiState,
    sandbox_name: &str,
    token: &str,
    required: SandboxRole,
) -> Result<(), ApiError> {
    let entry = state.get_sandbox(sandbox_name)?;
    let entry = entry.lock();

    // Backwards compatible: if no owner was set, RBAC is disabled for this sandbox
    if entry.owner_token_hash.is_none() {
        return Ok(());
    }

    let token_hash = hash_token(token);

    // Check permissions list for this token
    for perm in &entry.permissions {
        if perm.token_hash == token_hash {
            // Check role hierarchy: Owner >= Operator >= ReadOnly
            if perm.role >= required {
                return Ok(());
            } else {
                return Err(ApiError::Forbidden(format!(
                    "insufficient permissions: have '{}', need '{}' on sandbox '{}'",
                    perm.role, required, sandbox_name
                )));
            }
        }
    }

    // Token not in permissions list at all
    Err(ApiError::Forbidden(format!(
        "no permissions on sandbox '{}'",
        sandbox_name
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_constant_time_eq() {
        assert!(constant_time_eq(b"hello", b"hello"));
        assert!(!constant_time_eq(b"hello", b"world"));
        assert!(!constant_time_eq(b"short", b"longer"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn test_generate_token() {
        let token = generate_token().unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        // Two tokens should be different
        let token2 = generate_token().unwrap();
        assert_ne!(token, token2);
    }

    #[test]
    fn test_hash_token() {
        let hash = hash_token("my-secret-token");
        assert_eq!(hash.len(), 16);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        // Deterministic
        assert_eq!(hash, hash_token("my-secret-token"));
        // Different tokens produce different hashes
        assert_ne!(hash, hash_token("other-token"));
    }

    #[test]
    fn test_extract_bearer_token() {
        let mut headers = axum::http::HeaderMap::new();
        assert!(extract_bearer_token(&headers).is_none());

        headers.insert(
            header::AUTHORIZATION,
            "Bearer my-token".parse().unwrap(),
        );
        assert_eq!(extract_bearer_token(&headers).unwrap(), "my-token");

        headers.insert(
            header::AUTHORIZATION,
            "Basic dXNlcjpwYXNz".parse().unwrap(),
        );
        assert!(extract_bearer_token(&headers).is_none());
    }

    #[test]
    fn test_sandbox_role_ordering() {
        assert!(SandboxRole::Owner > SandboxRole::Operator);
        assert!(SandboxRole::Operator > SandboxRole::ReadOnly);
        assert!(SandboxRole::Owner >= SandboxRole::Owner);
        assert!(SandboxRole::Owner >= SandboxRole::ReadOnly);
    }
}
