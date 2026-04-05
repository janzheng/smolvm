//! Built-in AI API service definitions for the secret proxy.
//!
//! Each service defines how to forward requests and inject authentication
//! headers for a specific API provider.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Definition of an API service that the secret proxy can forward to.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SecretService {
    /// Short name (e.g., "anthropic", "openai").
    pub name: String,
    /// Base URL for the real API (e.g., "https://api.anthropic.com").
    pub base_url: String,
    /// HTTP header name for authentication (e.g., "x-api-key", "Authorization").
    pub auth_header: String,
    /// Prefix before the key value (e.g., "" for Anthropic, "Bearer " for OpenAI).
    pub auth_prefix: String,
    /// Environment variable name for the API key inside the VM.
    pub env_key_name: String,
    /// Environment variable name for the base URL inside the VM.
    pub env_url_name: String,
}

/// Built-in service definitions for major AI API providers.
pub fn builtin_services() -> HashMap<String, SecretService> {
    let services = vec![
        SecretService {
            name: "anthropic".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            auth_header: "x-api-key".to_string(),
            auth_prefix: "".to_string(),
            env_key_name: "ANTHROPIC_API_KEY".to_string(),
            env_url_name: "ANTHROPIC_BASE_URL".to_string(),
        },
        SecretService {
            name: "openai".to_string(),
            base_url: "https://api.openai.com".to_string(),
            auth_header: "Authorization".to_string(),
            auth_prefix: "Bearer ".to_string(),
            env_key_name: "OPENAI_API_KEY".to_string(),
            env_url_name: "OPENAI_BASE_URL".to_string(),
        },
        SecretService {
            name: "google".to_string(),
            base_url: "https://generativelanguage.googleapis.com".to_string(),
            auth_header: "x-goog-api-key".to_string(),
            auth_prefix: "".to_string(),
            env_key_name: "GOOGLE_API_KEY".to_string(),
            env_url_name: "GOOGLE_BASE_URL".to_string(),
        },
    ];

    services.into_iter().map(|s| (s.name.clone(), s)).collect()
}

/// TOML config file format for custom service definitions.
#[derive(Debug, Deserialize)]
pub struct ServicesConfig {
    /// List of custom service definitions.
    #[serde(default)]
    pub services: Vec<SecretService>,
}

/// Load custom services from a TOML config file and merge with built-in defaults.
///
/// Custom services override built-in services with the same name.
pub fn load_services_config(path: &std::path::Path) -> Result<HashMap<String, SecretService>, String> {
    let mut services = builtin_services();

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read services config '{}': {}", path.display(), e))?;

    let config: ServicesConfig = toml::from_str(&content)
        .map_err(|e| format!("failed to parse services config '{}': {}", path.display(), e))?;

    for svc in config.services {
        services.insert(svc.name.clone(), svc);
    }

    Ok(services)
}

/// Try to load the default services config from ~/.smolvm/services.toml.
/// Returns the built-in defaults if the file doesn't exist.
pub fn load_default_config() -> HashMap<String, SecretService> {
    if let Some(home) = dirs::home_dir() {
        let path = home.join(".smolvm").join("services.toml");
        if path.exists() {
            match load_services_config(&path) {
                Ok(services) => {
                    tracing::info!(
                        path = %path.display(),
                        count = services.len(),
                        "loaded custom services config"
                    );
                    return services;
                }
                Err(e) => {
                    tracing::warn!(error = %e, "failed to load default services config, using built-ins");
                }
            }
        }
    }
    builtin_services()
}

/// Placeholder API key value set inside the VM.
/// This value is useless outside the proxy — it can't authenticate with any real API.
pub const PLACEHOLDER_KEY: &str = "smolvm-placeholder-not-a-real-key";

/// Port the guest-side proxy listens on inside the VM.
pub const GUEST_PROXY_PORT: u16 = 9800;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_services_registered() {
        let services = builtin_services();
        assert!(services.contains_key("anthropic"));
        assert!(services.contains_key("openai"));
        assert!(services.contains_key("google"));
    }

    #[test]
    fn test_anthropic_service_config() {
        let services = builtin_services();
        let svc = &services["anthropic"];
        assert_eq!(svc.auth_header, "x-api-key");
        assert_eq!(svc.auth_prefix, "");
        assert_eq!(svc.env_key_name, "ANTHROPIC_API_KEY");
    }

    #[test]
    fn test_openai_service_config() {
        let services = builtin_services();
        let svc = &services["openai"];
        assert_eq!(svc.auth_header, "Authorization");
        assert_eq!(svc.auth_prefix, "Bearer ");
    }

    #[test]
    fn test_services_config_toml_parse() {
        let toml_str = r#"
[[services]]
name = "github"
base_url = "https://api.github.com"
auth_header = "Authorization"
auth_prefix = "Bearer "
env_key_name = "GITHUB_TOKEN"
env_url_name = "GITHUB_API_URL"
"#;
        let config: ServicesConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.services.len(), 1);
        assert_eq!(config.services[0].name, "github");
        assert_eq!(config.services[0].base_url, "https://api.github.com");
    }

    #[test]
    fn test_services_config_override() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("services.toml");
        std::fs::write(&path, r#"
[[services]]
name = "anthropic"
base_url = "https://custom.anthropic.com"
auth_header = "x-api-key"
auth_prefix = ""
env_key_name = "ANTHROPIC_API_KEY"
env_url_name = "ANTHROPIC_BASE_URL"

[[services]]
name = "github"
base_url = "https://api.github.com"
auth_header = "Authorization"
auth_prefix = "Bearer "
env_key_name = "GITHUB_TOKEN"
env_url_name = "GITHUB_API_URL"
"#).unwrap();

        let services = load_services_config(&path).unwrap();
        // Built-in anthropic should be overridden
        assert_eq!(services["anthropic"].base_url, "https://custom.anthropic.com");
        // New service should be added
        assert!(services.contains_key("github"));
        // Other built-ins should remain
        assert!(services.contains_key("openai"));
        assert!(services.contains_key("google"));
    }
}
