//! Prometheus metrics for smolvm.
//!
//! Initializes a Prometheus recorder and provides helpers for recording metrics.

use metrics::{counter, gauge, histogram};
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};

/// Initialize the Prometheus metrics recorder.
///
/// Returns a handle that can render the current metrics in Prometheus text format.
/// Must be called once at server startup before any metrics are recorded.
pub fn init() -> PrometheusHandle {
    PrometheusBuilder::new()
        .build_recorder()
        .handle()
}

// ============================================================================
// Metric recording helpers
// ============================================================================

/// Record a sandbox creation event.
pub fn record_sandbox_created() {
    counter!("smolvm_sandboxes_created_total").increment(1);
}

/// Record a sandbox deletion event.
pub fn record_sandbox_deleted() {
    counter!("smolvm_sandboxes_deleted_total").increment(1);
}

/// Record sandbox boot time in seconds.
pub fn record_sandbox_boot_time(secs: f64) {
    histogram!("smolvm_sandbox_boot_seconds").record(secs);
}

/// Record exec command duration in seconds.
pub fn record_exec_duration(secs: f64) {
    histogram!("smolvm_exec_duration_seconds").record(secs);
}

/// Record an exec command invocation.
pub fn record_exec_called() {
    counter!("smolvm_exec_total").increment(1);
}

/// Set the current number of active sandboxes.
pub fn set_active_sandboxes(n: u64) {
    gauge!("smolvm_sandboxes_active").set(n as f64);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_init_returns_handle() {
        // Verify init() produces a valid handle that can render
        let handle = init();
        let output = handle.render();
        assert!(output.is_ascii());
    }

    #[test]
    fn test_metrics_helpers_dont_panic() {
        // The metrics macros go to a global recorder. In test context
        // the recorder may not be installed, but the calls must not panic.
        record_sandbox_created();
        record_sandbox_deleted();
        record_exec_called();
        record_exec_duration(0.5);
        record_sandbox_boot_time(1.2);
        set_active_sandboxes(3);
    }
}
