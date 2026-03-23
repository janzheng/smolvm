//! HTTP API server command.

use clap::Parser;
use std::net::SocketAddr;
use std::sync::Arc;

use smolvm::api::state::ApiState;
use smolvm::Result;

use super::openapi::OpenapiCmd;

/// Start the HTTP API server for programmatic control.
#[derive(Parser, Debug)]
#[command(about = "Start the HTTP API server for programmatic sandbox management")]
pub enum ServeCmd {
    /// Start the HTTP API server
    #[command(after_long_help = "\
Sandboxes persist independently of the server - they continue running even if the server stops.

API ENDPOINTS:
  GET    /health                       Health check
  POST   /api/v1/sandboxes             Create sandbox
  GET    /api/v1/sandboxes             List sandboxes
  GET    /api/v1/sandboxes/:id         Get sandbox status
  POST   /api/v1/sandboxes/:id/start   Start sandbox
  POST   /api/v1/sandboxes/:id/stop    Stop sandbox
  POST   /api/v1/sandboxes/:id/exec    Execute command
  DELETE /api/v1/sandboxes/:id         Delete sandbox

EXAMPLES:
  smolvm serve start                         Listen on 127.0.0.1:8080 (default)
  smolvm serve start -l 0.0.0.0:9000         Listen on all interfaces, port 9000
  smolvm serve start -v                      Enable verbose logging")]
    Start(ServeStartCmd),

    /// Export OpenAPI specification for SDK generation
    Openapi(OpenapiCmd),
}

impl ServeCmd {
    pub fn run(self) -> Result<()> {
        match self {
            ServeCmd::Start(cmd) => cmd.run(),
            ServeCmd::Openapi(cmd) => cmd.run(),
        }
    }
}

#[derive(Parser, Debug)]
pub struct ServeStartCmd {
    /// Address and port to listen on
    #[arg(
        short,
        long,
        default_value = "127.0.0.1:8080",
        value_name = "ADDR:PORT"
    )]
    listen: String,

    /// Enable debug logging (or set RUST_LOG=debug)
    #[arg(short, long)]
    verbose: bool,

    /// CORS allowed origins (repeatable). Defaults to localhost:8080 and localhost:3000.
    #[arg(long = "cors-origin", value_name = "ORIGIN")]
    cors_origins: Vec<String>,

    /// Output logs in JSON format (for production log aggregation)
    #[arg(long)]
    json_logs: bool,

    /// API bearer token for authentication. Also reads SMOLVM_API_TOKEN env var.
    /// When set, all /api/v1/* requests require `Authorization: Bearer <token>`.
    #[arg(long = "api-token", value_name = "TOKEN")]
    api_token: Option<String>,

    /// Generate a random API token at startup and print it to stderr.
    /// Ignored if --api-token or SMOLVM_API_TOKEN is already set.
    #[arg(long)]
    generate_token: bool,

    /// Register a secret for the secret proxy (repeatable).
    /// Format: NAME=VALUE (e.g., --secret anthropic=test-ant-xxx).
    /// Also reads SMOLVM_SECRET_* environment variables.
    /// Secrets are injected into sandboxes that request them via the `secrets` field,
    /// without the real key ever entering the VM.
    #[arg(long = "secret", value_name = "NAME=VALUE")]
    secrets: Vec<String>,

    /// Path to a TOML config file defining custom proxy services.
    /// Defaults to ~/.smolvm/services.toml if it exists.
    /// Custom services are merged with built-in definitions (anthropic, openai, google).
    #[arg(long = "services-config", value_name = "PATH")]
    services_config: Option<String>,

    /// Path to the web dashboard directory (containing index.html).
    /// Auto-detected relative to the binary if not specified.
    /// Set to "none" to disable the web dashboard.
    #[arg(long = "web-ui", value_name = "PATH")]
    web_ui: Option<String>,
}

impl ServeStartCmd {
    /// Run the serve command.
    pub fn run(self) -> Result<()> {
        // Parse listen address
        let addr: SocketAddr = self.listen.parse().map_err(|e| {
            smolvm::error::Error::config(
                "parse listen address",
                format!("invalid address '{}': {}", self.listen, e),
            )
        })?;

        // Set up verbose logging if requested
        if self.verbose {
            // Re-initialize logging at debug level
            // Note: This won't work if logging is already initialized,
            // but the RUST_LOG env var can be used instead
            tracing::info!("verbose logging enabled");
        }

        // Create the runtime with signal handling enabled
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(smolvm::error::Error::Io)?;

        runtime.block_on(async move { self.run_server(addr).await })
    }

    async fn run_server(self, addr: SocketAddr) -> Result<()> {
        // Load service definitions: explicit config > ~/.smolvm/services.toml > built-ins
        let service_registry = if let Some(ref config_path) = self.services_config {
            let path = std::path::Path::new(config_path);
            let services = smolvm::proxy::services::load_services_config(path).map_err(|e| {
                smolvm::error::Error::config("load services config", e)
            })?;
            let names: Vec<_> = services.keys().collect();
            eprintln!("Loaded {} service definitions from {}: {:?}", services.len(), config_path, names);
            services
        } else {
            smolvm::proxy::services::load_default_config()
        };

        // Parse secret proxy configuration using the loaded service registry
        let proxy_config = {
            let secrets = smolvm::proxy::parse_secrets(&self.secrets).map_err(|e| {
                smolvm::error::Error::config("parse secrets", e)
            })?;
            if !secrets.is_empty() {
                let config = smolvm::proxy::ProxyConfig::with_services(secrets.clone(), service_registry.clone());
                let service_names: Vec<_> = config.services.keys().collect();
                eprintln!("Secret proxy configured for: {}", service_names.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "));
                let unknown: Vec<_> = secrets.keys()
                    .filter(|k| !config.services.contains_key(k.as_str()))
                    .collect();
                if !unknown.is_empty() {
                    eprintln!("WARNING: Unknown service names (no service definition): {:?}", unknown);
                    eprintln!("         These secrets won't be proxied. Use --services-config to define custom services.");
                }
                Some(config)
            } else {
                None
            }
        };

        // Resolve API token: CLI flag > env var > generate > none
        let api_token = match self.api_token.or_else(|| std::env::var("SMOLVM_API_TOKEN").ok()) {
            Some(token) => Some(token),
            None if self.generate_token => {
                let token = smolvm::api::auth::generate_token().map_err(|e| {
                    smolvm::error::Error::config("generate token", e.to_string())
                })?;
                eprintln!("Generated API token: {}", token);
                eprintln!("Use: -H \"Authorization: Bearer {}\"", token);
                Some(token)
            }
            None => None,
        };

        // Security warnings
        if api_token.is_none() {
            eprintln!("WARNING: No API token configured. The API is unauthenticated.");
            eprintln!("         Use --api-token <TOKEN>, set SMOLVM_API_TOKEN, or use --generate-token.");
        }
        if addr.ip().is_unspecified() {
            eprintln!(
                "WARNING: Server is listening on all interfaces ({}).",
                addr.ip()
            );
            if api_token.is_none() {
                eprintln!("         Any network client can control this host without authentication.");
            }
            eprintln!("         Consider using --listen 127.0.0.1:8080 for local-only access.");
        }

        // Create shared state and load persisted sandboxes
        let mut api_state = ApiState::new().map_err(|e| {
            smolvm::error::Error::config("initialize api state", format!("{:?}", e))
        })?;
        api_state.set_service_registry(service_registry);
        if let Some(pc) = proxy_config {
            api_state.set_proxy_config(pc);
        }
        let state = Arc::new(api_state);
        let loaded = state.load_persisted_sandboxes();
        if !loaded.is_empty() {
            println!(
                "Reconnected to {} existing sandbox(es): {}",
                loaded.len(),
                loaded.join(", ")
            );
        }

        // Create shutdown channel for supervisor
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

        // Spawn supervisor task
        let supervisor_state = state.clone();
        let supervisor_handle = tokio::spawn(async move {
            let supervisor =
                smolvm::api::supervisor::Supervisor::new(supervisor_state, shutdown_rx);
            supervisor.run().await;
        });

        // Resolve web-ui directory
        let web_ui_dir = match self.web_ui.as_deref() {
            Some("none") => None,
            Some(path) => {
                let p = std::path::PathBuf::from(path);
                if p.join("index.html").exists() {
                    Some(p)
                } else {
                    tracing::warn!(path = %p.display(), "web-ui dir missing index.html, disabling");
                    None
                }
            }
            None => {
                // Auto-detect: check relative to executable, then CWD
                let candidates = [
                    std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.join("web-ui"))),
                    std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.join("../web-ui"))),
                    Some(std::path::PathBuf::from("web-ui")),
                ];
                candidates
                    .into_iter()
                    .flatten()
                    .find(|p| p.join("index.html").exists())
            }
        };

        if let Some(ref dir) = web_ui_dir {
            tracing::info!(path = %dir.display(), "serving web dashboard");
            println!("Web dashboard at http://{}/", addr);
        }

        // Create router
        let app = smolvm::api::create_router(state, self.cors_origins, api_token, web_ui_dir);

        // Create listener
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(smolvm::error::Error::Io)?;

        tracing::info!(address = %addr, "starting HTTP API server");
        println!("smolvm API server listening on http://{}", addr);

        // Run the server with graceful shutdown (VMs keep running independently)
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal())
            .await
            .map_err(smolvm::error::Error::Io)?;

        // Signal supervisor to stop
        let _ = shutdown_tx.send(true);

        // Wait for supervisor to finish (with timeout)
        match tokio::time::timeout(std::time::Duration::from_secs(5), supervisor_handle).await {
            Ok(_) => tracing::debug!("supervisor shut down cleanly"),
            Err(_) => tracing::warn!("supervisor did not shut down within 5 seconds"),
        }

        Ok(())
    }
}

/// Wait for shutdown signal.
/// Note: VMs are NOT stopped on server shutdown - they run independently.
/// Use DELETE /api/v1/sandboxes/:id to stop specific VMs.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %e, "failed to listen for Ctrl+C");
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(e) => {
                tracing::error!(error = %e, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received");
    eprintln!("\nShutting down server (VMs continue running)...");
}
