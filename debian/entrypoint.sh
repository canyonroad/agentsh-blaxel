#!/bin/bash.real
# Entrypoint script for Blaxel Sandbox with agentsh (Debian)
# Starts the agentsh server and sandbox-api
#
# NOTE: Uses /bin/bash.real (original bash) because /bin/bash is now the
# agentsh shell shim. The shim requires the server to be running, which
# this script starts.

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
EOF
    export AGENTSH_SERVER=http://127.0.0.1:18080
}

# Main entry point
main() {
    log_info "Initializing Blaxel Sandbox with agentsh (Debian)..."

    # Create required directories if they don't exist
    mkdir -p /var/lib/agentsh/sessions /var/lib/agentsh/quarantine /var/log/agentsh

    # Start the agentsh server FIRST (required before sandbox-api, since
    # sandbox-api commands go through the shell shim which needs the server)
    start_agentsh_server

    # Configure environment
    configure_environment

    # Pre-create a session and enable AGENTSH_SHIM_FORCE for sandbox-api.
    # In agentsh 0.10.1+, the shell shim bypasses enforcement for non-TTY stdin.
    # AGENTSH_SHIM_FORCE=1 overrides this bypass. We pre-create the session here
    # so the shim doesn't need to auto-create one on first command.
    log_info "Creating agentsh session for shell shim..."
    AGENTSH_SESSION_JSON=$(agentsh session create --policy default --json 2>/dev/null || true)
    AGENTSH_SESSION_ID=$(echo "$AGENTSH_SESSION_JSON" | jq -r '.id // empty' 2>/dev/null || true)
    if [ -n "$AGENTSH_SESSION_ID" ]; then
        log_info "Session created: $AGENTSH_SESSION_ID"
        export AGENTSH_SHIM_FORCE=1
        export AGENTSH_SESSION_ID="$AGENTSH_SESSION_ID"
    else
        log_warn "Failed to create session, shim enforcement disabled"
    fi

    # Start Blaxel sandbox-api
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
