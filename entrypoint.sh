#!/bin/bash.real
# Entrypoint script for Blaxel Sandbox with agentsh
# Starts the agentsh server and installs the shell shim
#
# NOTE: Uses /bin/bash.real (original bash) because /bin/bash is now the
# agentsh shell shim. The shim requires the server to be running, which
# this script starts.

set -e

# Configuration
AGENTSH_SERVER_PORT=${AGENTSH_SERVER_PORT:-18080}
AGENTSH_CONFIG=${AGENTSH_CONFIG:-/etc/agentsh/config.yaml}
REAL_BASH="/bin/bash.real"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to wait for a port to be available
wait_for_port() {
    local port=$1
    local timeout=${2:-30}
    local start_time=$(date +%s)

    log_info "Waiting for port $port to be available..."

    while ! nc -z localhost "$port" 2>/dev/null; do
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))

        if [ $elapsed -ge $timeout ]; then
            log_error "Timeout waiting for port $port"
            return 1
        fi

        sleep 0.5
    done

    log_info "Port $port is available"
    return 0
}

# Start agentsh server directly
start_agentsh_server() {
    log_info "Starting agentsh server..."

    # Check if agentsh binary exists
    if ! command -v agentsh &> /dev/null; then
        log_error "agentsh binary not found!"
        return 1
    fi

    # Start the server directly in the background
    agentsh server --config "$AGENTSH_CONFIG" &
    AGENTSH_PID=$!

    # Give it time to start
    sleep 2
    if kill -0 $AGENTSH_PID 2>/dev/null; then
        log_info "agentsh server started (PID: $AGENTSH_PID)"
        # Verify it's listening
        if nc -z localhost "$AGENTSH_SERVER_PORT" 2>/dev/null; then
            log_info "agentsh server listening on port $AGENTSH_SERVER_PORT"
        else
            log_warn "agentsh server started but port $AGENTSH_SERVER_PORT not yet ready"
        fi
    else
        log_warn "agentsh server may not have started"
    fi
}

# Install shell shim (DISABLED - causes all sandbox-api commands to hang)
install_shell_shim() {
    log_info "Shell shim installation disabled for sandbox compatibility"
    log_info "Use 'agentsh exec -- <command>' for policy enforcement"

    # Ensure AGENTSH_SERVER is set in /etc/environment for all processes
    echo "AGENTSH_SERVER=http://127.0.0.1:18080" >> /etc/environment
    export AGENTSH_SERVER=http://127.0.0.1:18080
}

# Main entry point
main() {
    log_info "Initializing Blaxel Sandbox with agentsh..."

    # Create required directories if they don't exist
    mkdir -p /var/lib/agentsh/sessions /var/lib/agentsh/quarantine /var/log/agentsh

    # IMPORTANT: Start Blaxel sandbox-api FIRST (required for sandbox functionality)
    # Note: In Blaxel, the sandbox-api port 8080 is exposed externally but may not be
    # on localhost:8080 internally, so we don't wait for the port
    if command -v sandbox-api &> /dev/null; then
        log_info "Starting Blaxel sandbox API..."
        sandbox-api &
        SANDBOX_API_PID=$!
        # Give it time to start but don't block on port check
        sleep 2
        if kill -0 $SANDBOX_API_PID 2>/dev/null; then
            log_info "Blaxel sandbox API started (PID: $SANDBOX_API_PID)"
        else
            log_warn "sandbox-api may not have started correctly"
        fi
    else
        log_warn "sandbox-api not found - sandbox process API will not be available"
    fi

    # Start the agentsh server
    start_agentsh_server

    # Install the shell shim
    install_shell_shim

    log_info "agentsh initialization complete"
    log_info "Server running at http://localhost:$AGENTSH_SERVER_PORT"

    # If additional command is provided, run it
    if [ $# -gt 0 ]; then
        log_info "Running command: $@"
        exec "$@"
    else
        # Keep the container running
        log_info "Sandbox ready. Waiting for commands..."
        wait
    fi
}

# Handle signals for graceful shutdown
cleanup() {
    log_info "Shutting down..."
    kill $AGENTSH_PID 2>/dev/null || true
    kill $SANDBOX_API_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGTERM SIGINT

# Run main
main "$@"
