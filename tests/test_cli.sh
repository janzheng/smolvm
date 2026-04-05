#!/bin/bash
#
# CLI tests for smolvm.
#
# Tests basic CLI functionality like --version and --help.
# Does not require VM environment.
#
# Usage:
#   ./tests/test_cli.sh

source "$(dirname "$0")/common.sh"
init_smolvm

echo ""
echo "=========================================="
echo "  smolvm CLI Tests"
echo "=========================================="
echo ""

# =============================================================================
# Version and Help
# =============================================================================

test_version() {
    local output
    output=$($SMOLVM --version 2>&1)
    [[ "$output" == *"smolvm"* ]]
}

test_help() {
    local output
    output=$($SMOLVM --help 2>&1)
    [[ "$output" == *"machine"* ]] && \
    [[ "$output" == *"microvm"* ]] && \
    [[ "$output" == *"container"* ]]
}

test_machine_help() {
    local output
    output=$($SMOLVM machine --help 2>&1)
    [[ "$output" == *"run"* ]]
}

test_machine_run_platform_flag() {
    # Verify --oci-platform flag exists in machine run help
    local output
    output=$($SMOLVM machine run --help 2>&1)
    [[ "$output" == *"--oci-platform"* ]] && \
    [[ "$output" == *"linux/arm64"* ]] && \
    [[ "$output" == *"linux/amd64"* ]]
}

test_pack_platform_flag() {
    # Verify --oci-platform flag exists in pack help
    local output
    output=$($SMOLVM pack create --help 2>&1)
    [[ "$output" == *"--oci-platform"* ]] && \
    [[ "$output" == *"linux/arm64"* ]] && \
    [[ "$output" == *"linux/amd64"* ]]
}

test_microvm_help() {
    local output
    output=$($SMOLVM microvm --help 2>&1)
    [[ "$output" == *"start"* ]] && \
    [[ "$output" == *"stop"* ]] && \
    [[ "$output" == *"status"* ]]
}

test_container_help() {
    local output
    output=$($SMOLVM container --help 2>&1)
    [[ "$output" == *"create"* ]] && \
    [[ "$output" == *"start"* ]] && \
    [[ "$output" == *"stop"* ]] && \
    [[ "$output" == *"list"* ]] && \
    [[ "$output" == *"remove"* ]]
}

# =============================================================================
# Invalid Commands
# =============================================================================

test_invalid_subcommand() {
    # Should fail for invalid subcommand
    ! $SMOLVM nonexistent-command 2>/dev/null
}

test_machine_run_missing_image() {
    # Should fail when image is not provided
    ! $SMOLVM machine run 2>/dev/null
}

# =============================================================================
# Disk Size Flags
# =============================================================================

test_microvm_create_overlay_flag() {
    # Verify --overlay flag exists in microvm create help
    local output
    output=$($SMOLVM microvm create --help 2>&1)
    [[ "$output" == *"--overlay"* ]] && \
    [[ "$output" == *"GiB"* ]]
}

test_microvm_create_storage_flag() {
    # Verify --storage flag exists in microvm create help
    local output
    output=$($SMOLVM microvm create --help 2>&1)
    [[ "$output" == *"--storage"* ]] && \
    [[ "$output" == *"GiB"* ]]
}

test_machine_create_overlay_flag() {
    # Verify --overlay flag exists in machine create help
    local output
    output=$($SMOLVM machine create --help 2>&1)
    [[ "$output" == *"--overlay"* ]] && \
    [[ "$output" == *"GiB"* ]]
}

test_machine_run_overlay_flag() {
    # Verify --overlay flag exists in machine run help
    local output
    output=$($SMOLVM machine run --help 2>&1)
    [[ "$output" == *"--overlay"* ]] && \
    [[ "$output" == *"GiB"* ]]
}

# =============================================================================
# Run Tests
# =============================================================================

run_test "Version command" test_version || true
run_test "Help command" test_help || true
run_test "Machine help" test_machine_help || true
run_test "Machine run --oci-platform flag" test_machine_run_platform_flag || true
run_test "Pack --oci-platform flag" test_pack_platform_flag || true
run_test "Microvm help" test_microvm_help || true
run_test "Container help" test_container_help || true
run_test "Invalid subcommand fails" test_invalid_subcommand || true
run_test "Machine run without image fails" test_machine_run_missing_image || true
run_test "Microvm create --overlay flag" test_microvm_create_overlay_flag || true
run_test "Microvm create --storage flag" test_microvm_create_storage_flag || true
run_test "Machine create --overlay flag" test_machine_create_overlay_flag || true
run_test "Machine run --overlay flag" test_machine_run_overlay_flag || true

print_summary "CLI Tests"
