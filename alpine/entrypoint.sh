#!/bin/bash
# Entrypoint script for Blaxel Sandbox with agentsh (Alpine)
# Starts the agentsh server and sandbox-api
#
# NOTE: Uses /bin/bash (not bash.real) because shell shim is NOT installed
# on Alpine due to BusyBox incompatibility.

set -e

# Configuration
AGENTSH_SERVER_PORT=${AGENTSH_SERVER_PORT:-18080}
AGENTSH_CONFIG=${AGENTSH_CONFIG:-/etc/agentsh/config.yaml}

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

# Wait for a port to be available
wait_for_port() {
    local port=$1
    local timeout=${2:-30}
    local start_time=$(date +%s)

    while ! nc -z localhost "$port" 2>/dev/null; do
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))

        if [ $elapsed -ge $timeout ]; then
            log_error "Timeout waiting for port $port"
            return 1
        fi

        sleep 0.5
    done
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

    # Wait for it to start listening
    if wait_for_port "$AGENTSH_SERVER_PORT" 10; then
        log_info "agentsh server started (PID: $AGENTSH_PID, port: $AGENTSH_SERVER_PORT)"
    else
        log_warn "agentsh server started (PID: $AGENTSH_PID) but port not yet ready"
    fi
}

# Configure environment (idempotent)
configure_environment() {
    log_info "Configuring environment..."

    # Write environment file (overwrite, not append — safe on restart)
    cat > /etc/environment <<EOF
AGENTSH_SERVER=http://127.0.0.1:18080
BASH_ENV=/usr/lib/agentsh/bash_startup.sh
EOF
    export AGENTSH_SERVER=http://127.0.0.1:18080
    export BASH_ENV=/usr/lib/agentsh/bash_startup.sh
}

# Main entry point
main() {
    log_info "Initializing Blaxel Sandbox with agentsh (Alpine)..."
    log_warn "Shell shim NOT installed - commands bypass policy enforcement"
    log_info "Use 'agentsh exec -- <command>' for policy enforcement"

    # Create required directories if they don't exist
    mkdir -p /var/lib/agentsh/sessions /var/lib/agentsh/quarantine /var/log/agentsh

    # IMPORTANT: Start Blaxel sandbox-api FIRST (required for sandbox functionality)
    if command -v sandbox-api &> /dev/null; then
        log_info "Starting Blaxel sandbox API..."
        sandbox-api &
        SANDBOX_API_PID=$!
        if wait_for_port 8080 10; then
            log_info "Blaxel sandbox API started (PID: $SANDBOX_API_PID, port: 8080)"
        else
            log_warn "sandbox-api started (PID: $SANDBOX_API_PID) but port not yet ready"
        fi
    else
        log_warn "sandbox-api not found - sandbox process API will not be available"
    fi

    # Start the agentsh server
    start_agentsh_server

    # Configure environment
    configure_environment

    log_info "agentsh initialization complete"
    log_info "Server running at http://localhost:$AGENTSH_SERVER_PORT"

    # If additional command is provided, run it
    if [ $# -gt 0 ]; then
        log_info "Running command: $@"
        exec "$@"
    else
        # Monitor daemons — exit if either crashes so orchestrator can restart
        log_info "Sandbox ready. Monitoring daemons..."
        while true; do
            if [ -n "$AGENTSH_PID" ] && ! kill -0 $AGENTSH_PID 2>/dev/null; then
                log_error "agentsh daemon crashed (was PID: $AGENTSH_PID)"
                exit 1
            fi
            if [ -n "$SANDBOX_API_PID" ] && ! kill -0 $SANDBOX_API_PID 2>/dev/null; then
                log_error "sandbox-api daemon crashed (was PID: $SANDBOX_API_PID)"
                exit 1
            fi
            sleep 5
        done
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
