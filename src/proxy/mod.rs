//! Secret proxy for safe API key injection into sandboxes.
//!
//! The secret proxy prevents API key exfiltration by keeping real keys on the
//! host side. Inside the VM, SDKs are configured with `*_BASE_URL=http://localhost:9800/<service>`
//! and a placeholder API key. The guest-side proxy forwards requests over vsock to
//! the host, where the real key is injected before proxying to the actual API.
//!
//! ```text
//! VM (untrusted code)                    Host (trusted)
//! ─────────────────                      ──────────────
//! SDK: ANTHROPIC_BASE_URL=
//!   http://localhost:9800/anthropic
//!          │
//!          ▼
//! [Agent proxy: 127.0.0.1:9800]
//!   Pipes bytes over vsock:6100
//!          │
//!          ▼ (vsock)
//!                                        [Secret Proxy on proxy.sock]
//!                                          Adds x-api-key: test-ant-xxx
//!                                          Proxies to api.anthropic.com
//!                                          Streams response back
//! ```

pub mod handler;
pub mod services;

pub use handler::ProxyConfig;
pub use services::{SecretService, ServicesConfig, GUEST_PROXY_PORT, PLACEHOLDER_KEY};

use std::collections::HashMap;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::Arc;

/// Start the host-side secret proxy on a Unix socket.
///
/// This is spawned as a background thread per sandbox. It listens for
/// HTTP requests from the guest-side proxy (via vsock → Unix socket)
/// and forwards them with real credentials.
///
/// Returns a join handle that can be used to stop the proxy.
pub fn start_proxy_listener(
    socket_path: &Path,
    config: ProxyConfig,
    sandbox_name: String,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    // Clean up old socket
    let _ = std::fs::remove_file(socket_path);

    let listener = UnixListener::bind(socket_path)?;
    let config = Arc::new(config);

    tracing::info!(
        sandbox = %sandbox_name,
        socket = %socket_path.display(),
        services = ?config.services.keys().collect::<Vec<_>>(),
        "secret proxy listening"
    );

    let handle = std::thread::Builder::new()
        .name(format!("proxy-{}", sandbox_name))
        .spawn(move || {
            // Create a shared HTTP client for this proxy instance
            let http_client = match reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!(error = %e, "failed to create HTTP client for secret proxy");
                    return;
                }
            };

            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let config = Arc::clone(&config);
                        let client = http_client.clone();
                        // Handle each connection in its own thread to support
                        // concurrent API calls from the VM
                        std::thread::spawn(move || {
                            handler::handle_proxy_connection(stream, &config, &client);
                        });
                    }
                    Err(e) => {
                        // Socket was closed (sandbox shutting down)
                        if e.kind() == std::io::ErrorKind::Other
                            || e.kind() == std::io::ErrorKind::BrokenPipe
                        {
                            break;
                        }
                        tracing::debug!(error = %e, "proxy accept error");
                    }
                }
            }

            tracing::debug!(sandbox = %sandbox_name, "secret proxy shut down");
        })?;

    Ok(handle)
}

/// Parse `--secret name=value` CLI arguments into a HashMap.
pub fn parse_secrets(secret_args: &[String]) -> Result<HashMap<String, String>, String> {
    let mut secrets = HashMap::new();
    for arg in secret_args {
        if let Some((name, value)) = arg.split_once('=') {
            secrets.insert(name.to_string(), value.to_string());
        } else {
            return Err(format!(
                "invalid secret format '{}': expected NAME=VALUE",
                arg
            ));
        }
    }

    // Also read SMOLVM_SECRET_* environment variables
    for (key, value) in std::env::vars() {
        if let Some(name) = key.strip_prefix("SMOLVM_SECRET_") {
            let name = name.to_lowercase();
            if !secrets.contains_key(&name) {
                secrets.insert(name, value);
            }
        }
    }

    Ok(secrets)
}

/// Validate that requested secret names are configured on the server.
pub fn validate_secret_names(
    requested: &[String],
    config: &ProxyConfig,
) -> Result<(), Vec<String>> {
    let missing: Vec<String> = requested
        .iter()
        .filter(|name| !config.secrets.contains_key(name.as_str()))
        .cloned()
        .collect();

    if missing.is_empty() {
        Ok(())
    } else {
        Err(missing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_secrets() {
        let args = vec![
            "anthropic=test-ant-xxx".to_string(),
            "openai=test-proj-yyy".to_string(),
        ];
        let secrets = parse_secrets(&args).unwrap();
        assert_eq!(secrets["anthropic"], "test-ant-xxx");
        assert_eq!(secrets["openai"], "test-proj-yyy");
    }

    #[test]
    fn test_parse_secrets_invalid() {
        let args = vec!["bad-format".to_string()];
        assert!(parse_secrets(&args).is_err());
    }

    #[test]
    fn test_validate_secret_names() {
        let mut secrets = HashMap::new();
        secrets.insert("anthropic".to_string(), "key".to_string());
        let config = ProxyConfig::new(secrets);

        // Valid
        assert!(validate_secret_names(&["anthropic".to_string()], &config).is_ok());

        // Invalid
        let result = validate_secret_names(&["anthropic".to_string(), "missing".to_string()], &config);
        assert_eq!(result.unwrap_err(), vec!["missing".to_string()]);
    }
}
