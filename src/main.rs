//! smolvm CLI entry point.

use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

mod cli;

/// smolvm - OCI-native microVM runtime
#[derive(Parser, Debug)]
#[command(name = "smolvm")]
#[command(about = "Run containers in lightweight VMs with VM-level isolation")]
#[command(
    long_about = "smolvm is an OCI-native microVM runtime for macOS and Linux.\n\n\
It runs container images inside lightweight VMs using libkrun, providing \
VM-level isolation with container-like UX.\n\n\
Quick start:\n  \
smolvm sandbox run alpine -- echo hello\n  \
smolvm sandbox run -d nginx -p 8080:80\n\n\
For programmatic access:\n  \
smolvm serve"
)]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run containers quickly (ephemeral or detached)
    #[command(subcommand, visible_alias = "sb")]
    Sandbox(cli::sandbox::SandboxCmd),

    /// Manage persistent microVMs
    #[command(subcommand, visible_alias = "vm")]
    Microvm(cli::microvm::MicrovmCmd),

    /// Manage containers inside a microVM
    #[command(subcommand, visible_alias = "ct")]
    Container(cli::container::ContainerCmd),

    /// Start the HTTP API server for programmatic control
    #[command(subcommand)]
    Serve(cli::serve::ServeCmd),

    /// Package and run self-contained VM executables
    #[command(subcommand)]
    Pack(cli::pack::PackCmd),

    /// Manage smolvm configuration (registries, defaults)
    #[command(subcommand)]
    Config(cli::config::ConfigCmd),
}

fn main() {
    // Auto-detect packed binary mode BEFORE parsing the normal CLI.
    // If this executable has a `.smolmachine` sidecar, appended assets,
    // or a Mach-O section with packed data, run as a packed binary instead.
    if let Some(mode) = smolvm_pack::detect_packed_mode() {
        cli::pack_run::run_as_packed_binary(mode);
    }

    // Check for --json-logs before parsing (it's a serve-subcommand flag)
    let json_logs = std::env::args().any(|a| a == "--json-logs");

    let cli = Cli::parse();

    // Initialize logging based on RUST_LOG or default to warn
    init_logging(json_logs);

    tracing::debug!(version = smolvm::VERSION, "starting smolvm");

    // Execute command
    let result = match cli.command {
        Commands::Sandbox(cmd) => cmd.run(),
        Commands::Microvm(cmd) => cmd.run(),
        Commands::Container(cmd) => cmd.run(),
        Commands::Serve(cmd) => cmd.run(),
        Commands::Pack(cmd) => cmd.run(),
        Commands::Config(cmd) => cmd.run(),
    };

    // Handle errors
    if let Err(e) = result {
        tracing::error!(error = %e, "command failed");
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

/// Initialize the tracing subscriber.
/// `json` enables JSON output format for production log aggregation.
fn init_logging(json: bool) {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("smolvm=warn"));

    if json {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(false)
            .init();
    }
}
