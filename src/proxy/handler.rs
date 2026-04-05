//! Host-side secret proxy handler.
//!
//! Accepts HTTP requests from the VM (via vsock), injects real API keys,
//! and proxies to the real API endpoint. The real keys never enter the VM.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;

use super::services::SecretService;

/// Configuration for the secret proxy.
#[derive(Debug, Clone)]
pub struct ProxyConfig {
    /// Map of service name -> real API key.
    pub secrets: HashMap<String, String>,
    /// Map of service name -> service definition.
    pub services: HashMap<String, SecretService>,
}

impl ProxyConfig {
    /// Create a new proxy config with the given secrets, using built-in service definitions.
    /// Only services with matching secrets are included.
    pub fn new(secrets: HashMap<String, String>) -> Self {
        let all_services = super::services::builtin_services();
        Self::with_services(secrets, all_services)
    }

    /// Create a new proxy config with the given secrets and a custom service registry.
    /// Only services with matching secrets are included.
    pub fn with_services(secrets: HashMap<String, String>, all_services: HashMap<String, SecretService>) -> Self {
        let services: HashMap<String, SecretService> = all_services
            .into_iter()
            .filter(|(name, _)| secrets.contains_key(name))
            .collect();
        Self { secrets, services }
    }

    /// Get the environment variables to inject into the VM for a set of secret names.
    ///
    /// Returns (name, value) pairs like:
    /// - ("ANTHROPIC_BASE_URL", "http://localhost:9800/anthropic")
    /// - ("ANTHROPIC_API_KEY", "smolvm-placeholder-not-a-real-key")
    pub fn env_vars_for_secrets(&self, secret_names: &[String]) -> Vec<(String, String)> {
        let mut vars = Vec::new();
        for name in secret_names {
            if let Some(svc) = self.services.get(name) {
                vars.push((
                    svc.env_url_name.to_string(),
                    format!(
                        "http://localhost:{}/{}",
                        super::services::GUEST_PROXY_PORT,
                        name
                    ),
                ));
                vars.push((
                    svc.env_key_name.to_string(),
                    super::services::PLACEHOLDER_KEY.to_string(),
                ));
            }
        }
        vars
    }

    /// Get the set of env var names that are managed by the proxy for the given secrets.
    ///
    /// These should NOT be overridden by user-provided env vars — doing so would
    /// leak real API keys into the VM, bypassing the proxy.
    pub fn protected_env_names(&self, secret_names: &[String]) -> std::collections::HashSet<String> {
        let mut names = std::collections::HashSet::new();
        for name in secret_names {
            if let Some(svc) = self.services.get(name) {
                names.insert(svc.env_key_name.to_string());
                names.insert(svc.env_url_name.to_string());
            }
        }
        names
    }

    /// Sanitize user-provided env vars and inject proxy defaults.
    ///
    /// When secrets are configured:
    /// 1. Strips user-provided env vars matching protected names (e.g., ANTHROPIC_API_KEY)
    /// 2. Injects proxy defaults (BASE_URL + placeholder key) for unset keys
    ///
    /// Returns the number of stripped env vars.
    pub fn sanitize_env(
        &self,
        env: &mut Vec<(String, String)>,
        secret_names: &[String],
        default_env: &[(String, String)],
    ) -> usize {
        let mut stripped = 0;

        // Strip protected env vars
        if !secret_names.is_empty() {
            let protected = self.protected_env_names(secret_names);
            let before = env.len();
            env.retain(|(k, _)| !protected.contains(k));
            stripped = before - env.len();
        }

        // Inject defaults for unset keys
        let user_keys: std::collections::HashSet<_> = env.iter().map(|(k, _)| k.clone()).collect();
        for (k, v) in default_env {
            if !user_keys.contains(k) {
                env.push((k.clone(), v.clone()));
            }
        }

        stripped
    }
}

/// Handle a single proxied HTTP request from the VM.
///
/// Reads an HTTP request from `stream`, determines the target service from
/// the URL path prefix, injects the real API key, and forwards to the real API.
/// Streams the response back to the VM.
pub fn handle_proxy_connection(
    mut stream: UnixStream,
    config: &ProxyConfig,
    http_client: &reqwest::blocking::Client,
) {
    if let Err(e) = handle_proxy_connection_inner(&mut stream, config, http_client) {
        tracing::debug!(error = %e, "proxy connection error");
        // Try to send a 502 error response
        let error_body = format!("{{\"error\":\"{}\"}}", e);
        let response = format!(
            "HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            error_body.len(),
            error_body
        );
        let _ = stream.write_all(response.as_bytes());
    }
}

fn handle_proxy_connection_inner(
    stream: &mut UnixStream,
    config: &ProxyConfig,
    http_client: &reqwest::blocking::Client,
) -> Result<(), Box<dyn std::error::Error>> {
    // Read the HTTP request line and headers
    let mut reader = BufReader::new(stream.try_clone()?);

    // Read request line (e.g., "POST /anthropic/v1/messages HTTP/1.1")
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let request_line = request_line.trim_end();

    let parts: Vec<&str> = request_line.splitn(3, ' ').collect();
    if parts.len() < 3 {
        return Err("malformed request line".into());
    }
    let method = parts[0];
    let path = parts[1];

    // Parse service name from path: /anthropic/v1/messages -> service="anthropic", rest="/v1/messages"
    let path = path.strip_prefix('/').unwrap_or(path);
    let (service_name, rest_path) = match path.find('/') {
        Some(idx) => (&path[..idx], &path[idx..]),
        None => (path, "/"),
    };

    let service = config
        .services
        .get(service_name)
        .ok_or_else(|| format!("unknown service: {}", service_name))?;

    let api_key = config
        .secrets
        .get(service_name)
        .ok_or_else(|| format!("no secret for service: {}", service_name))?;

    // Read headers
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim_end_matches("\r\n").trim_end_matches('\n');
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_lowercase();
            let value = value.trim().to_string();
            if name == "content-length" {
                content_length = value.parse().unwrap_or(0);
            }
            // Skip headers we'll rewrite
            if name == "host"
                || name == service.auth_header.to_lowercase().as_str()
                || name == "authorization"
            {
                continue;
            }
            headers.push((name, value));
        }
    }

    // Read body if present
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    // Build the real request
    let target_url = format!("{}{}", service.base_url, rest_path);

    let req_method = match method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        other => other.parse().map_err(|_| format!("unsupported method: {}", other))?,
    };

    let mut req = http_client.request(req_method, &target_url);

    // Add original headers (except host and auth which we stripped)
    for (name, value) in &headers {
        req = req.header(name.as_str(), value.as_str());
    }

    // Inject the real API key
    let auth_value = format!("{}{}", service.auth_prefix, api_key);
    req = req.header(service.auth_header.as_str(), &auth_value);

    // Add body
    if content_length > 0 {
        req = req.body(body);
    }

    tracing::debug!(
        service = service_name,
        target = %target_url,
        "proxying request with injected credentials"
    );

    // Send and get response
    let resp = req.send()?;

    let status = resp.status();
    let resp_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .filter(|(name, _)| {
            // Skip hop-by-hop headers
            let n = name.as_str();
            n != "transfer-encoding" && n != "connection"
        })
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or("").to_string(),
            )
        })
        .collect();

    let resp_body = resp.bytes()?;

    // Write HTTP response back to the VM
    let status_line = format!("HTTP/1.1 {} {}\r\n", status.as_u16(), status.canonical_reason().unwrap_or(""));
    stream.write_all(status_line.as_bytes())?;

    for (name, value) in &resp_headers {
        let header_line = format!("{}: {}\r\n", name, value);
        stream.write_all(header_line.as_bytes())?;
    }
    // Add content-length for the actual body
    let cl_line = format!("Content-Length: {}\r\nConnection: close\r\n", resp_body.len());
    stream.write_all(cl_line.as_bytes())?;

    stream.write_all(b"\r\n")?;
    stream.write_all(&resp_body)?;
    stream.flush()?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_proxy_config_env_vars() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "test-ant-test-123".to_string());
        let config = ProxyConfig::new(secrets);

        let vars = config.env_vars_for_secrets(&["anthropic".to_string()]);
        assert_eq!(vars.len(), 2);

        let url_var = vars.iter().find(|(k, _)| k == "ANTHROPIC_BASE_URL").unwrap();
        assert_eq!(url_var.1, "http://localhost:9800/anthropic");

        let key_var = vars.iter().find(|(k, _)| k == "ANTHROPIC_API_KEY").unwrap();
        assert!(key_var.1.contains("placeholder"));
    }

    #[test]
    fn test_proxy_config_unknown_service_ignored() {
        let mut secrets = HashMap::new();
        secrets.insert("unknown-service".to_string(), "key".to_string());
        let config = ProxyConfig::new(secrets);

        let vars = config.env_vars_for_secrets(&["unknown-service".to_string()]);
        assert!(vars.is_empty());
    }

    #[test]
    fn test_protected_env_names_anthropic() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "test-ant-test".to_string());
        let config = ProxyConfig::new(secrets);

        let protected = config.protected_env_names(&["anthropic".to_string()]);
        assert!(protected.contains("ANTHROPIC_API_KEY"));
        assert!(protected.contains("ANTHROPIC_BASE_URL"));
        assert!(!protected.contains("OPENAI_API_KEY"));
    }

    #[test]
    fn test_protected_env_names_multiple_services() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "test-ant-test".to_string());
        secrets.insert("openai".to_string(), "test-proj-test".to_string());
        let config = ProxyConfig::new(secrets);

        let protected = config.protected_env_names(&["anthropic".to_string(), "openai".to_string()]);
        assert_eq!(protected.len(), 4);
        assert!(protected.contains("ANTHROPIC_API_KEY"));
        assert!(protected.contains("ANTHROPIC_BASE_URL"));
        assert!(protected.contains("OPENAI_API_KEY"));
        assert!(protected.contains("OPENAI_BASE_URL"));
    }

    #[test]
    fn test_protected_env_names_empty_when_no_secrets() {
        let secrets = HashMap::new();
        let config = ProxyConfig::new(secrets);

        let protected = config.protected_env_names(&[]);
        assert!(protected.is_empty());
    }

    #[test]
    fn test_protected_env_names_unknown_service_ignored() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "key".to_string());
        let config = ProxyConfig::new(secrets);

        let protected = config.protected_env_names(&["unknown".to_string()]);
        assert!(protected.is_empty());
    }

    // ====================================================================
    // sanitize_env tests — the core security property
    // ====================================================================

    #[test]
    fn test_sanitize_strips_real_api_key() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "test-ant-real".to_string());
        let config = ProxyConfig::new(secrets);

        let default_env = config.env_vars_for_secrets(&["anthropic".to_string()]);
        let mut env = vec![
            ("ANTHROPIC_API_KEY".to_string(), "test-ant-real-key".to_string()),
            ("MY_VAR".to_string(), "safe-value".to_string()),
        ];

        let stripped = config.sanitize_env(&mut env, &["anthropic".to_string()], &default_env);

        assert_eq!(stripped, 1, "should strip ANTHROPIC_API_KEY");
        // Real key should be gone
        assert!(!env.iter().any(|(k, v)| k == "ANTHROPIC_API_KEY" && v == "test-ant-real-key"));
        // Placeholder should be injected
        let key_var = env.iter().find(|(k, _)| k == "ANTHROPIC_API_KEY").unwrap();
        assert!(key_var.1.contains("placeholder"));
        // Non-protected vars survive
        assert!(env.iter().any(|(k, _)| k == "MY_VAR"));
        // BASE_URL injected
        assert!(env.iter().any(|(k, _)| k == "ANTHROPIC_BASE_URL"));
    }

    #[test]
    fn test_sanitize_strips_base_url_override() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "test-ant-real".to_string());
        let config = ProxyConfig::new(secrets);

        let default_env = config.env_vars_for_secrets(&["anthropic".to_string()]);
        let mut env = vec![
            ("ANTHROPIC_BASE_URL".to_string(), "https://evil.com".to_string()),
        ];

        let stripped = config.sanitize_env(&mut env, &["anthropic".to_string()], &default_env);

        assert_eq!(stripped, 1, "should strip ANTHROPIC_BASE_URL override");
        // Should have proxy URL, not evil.com
        let url_var = env.iter().find(|(k, _)| k == "ANTHROPIC_BASE_URL").unwrap();
        assert!(url_var.1.contains("localhost:9800"));
    }

    #[test]
    fn test_sanitize_strips_multiple_services() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "test-ant-real".to_string());
        secrets.insert("openai".to_string(), "test-proj-real".to_string());
        let config = ProxyConfig::new(secrets);

        let secret_names = vec!["anthropic".to_string(), "openai".to_string()];
        let default_env = config.env_vars_for_secrets(&secret_names);
        let mut env = vec![
            ("ANTHROPIC_API_KEY".to_string(), "test-ant-real".to_string()),
            ("OPENAI_API_KEY".to_string(), "test-proj-real".to_string()),
            ("SAFE_VAR".to_string(), "ok".to_string()),
        ];

        let stripped = config.sanitize_env(&mut env, &secret_names, &default_env);

        assert_eq!(stripped, 2);
        assert!(env.iter().any(|(k, _)| k == "SAFE_VAR"));
        // Both should have placeholders
        let ant_key = env.iter().find(|(k, _)| k == "ANTHROPIC_API_KEY").unwrap();
        assert!(ant_key.1.contains("placeholder"));
        let oai_key = env.iter().find(|(k, _)| k == "OPENAI_API_KEY").unwrap();
        assert!(oai_key.1.contains("placeholder"));
    }

    #[test]
    fn test_sanitize_no_stripping_without_secrets() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "test-ant-real".to_string());
        let config = ProxyConfig::new(secrets);

        // Machine has NO secrets configured — env vars should pass through
        let mut env = vec![
            ("ANTHROPIC_API_KEY".to_string(), "test-ant-user-key".to_string()),
        ];

        let stripped = config.sanitize_env(&mut env, &[], &[]);

        assert_eq!(stripped, 0);
        assert_eq!(env[0].1, "test-ant-user-key", "should NOT strip when machine has no secrets");
    }

    #[test]
    fn test_sanitize_user_non_protected_vars_preserved() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "key".to_string());
        let config = ProxyConfig::new(secrets);

        let default_env = config.env_vars_for_secrets(&["anthropic".to_string()]);
        let mut env = vec![
            ("NODE_ENV".to_string(), "production".to_string()),
            ("DEBUG".to_string(), "true".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "leaked".to_string()),
        ];

        config.sanitize_env(&mut env, &["anthropic".to_string()], &default_env);

        assert!(env.iter().any(|(k, v)| k == "NODE_ENV" && v == "production"));
        assert!(env.iter().any(|(k, v)| k == "DEBUG" && v == "true"));
    }

    #[test]
    fn test_sanitize_defaults_dont_override_user_non_protected() {
        let secrets = HashMap::new();
        let config = ProxyConfig::new(secrets);

        let default_env = vec![
            ("MY_DEFAULT".to_string(), "default_val".to_string()),
        ];
        let mut env = vec![
            ("MY_DEFAULT".to_string(), "user_val".to_string()),
        ];

        config.sanitize_env(&mut env, &[], &default_env);

        // User's value should win for non-protected vars
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].1, "user_val");
    }

    #[test]
    fn test_env_vars_multiple_services() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "test-ant-test".to_string());
        secrets.insert("openai".to_string(), "test-proj-test".to_string());
        let config = ProxyConfig::new(secrets);

        let vars = config.env_vars_for_secrets(&["anthropic".to_string(), "openai".to_string()]);
        assert_eq!(vars.len(), 4); // 2 per service (BASE_URL + API_KEY)

        // Anthropic
        let url = vars.iter().find(|(k, _)| k == "ANTHROPIC_BASE_URL").unwrap();
        assert_eq!(url.1, "http://localhost:9800/anthropic");
        let key = vars.iter().find(|(k, _)| k == "ANTHROPIC_API_KEY").unwrap();
        assert!(key.1.contains("placeholder"));

        // OpenAI
        let url = vars.iter().find(|(k, _)| k == "OPENAI_BASE_URL").unwrap();
        assert_eq!(url.1, "http://localhost:9800/openai");
        let key = vars.iter().find(|(k, _)| k == "OPENAI_API_KEY").unwrap();
        assert!(key.1.contains("placeholder"));
    }
}
