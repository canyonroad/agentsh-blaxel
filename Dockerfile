# Blaxel Sandbox with agentsh Runtime Security (Debian)
# Based on the agentsh-e2b template adapted for Blaxel's sandbox platform

# Use glibc-based image (agentsh-unixwrap requires glibc)
FROM node:22-bookworm-slim

# Copy the Blaxel sandbox-api binary (REQUIRED for sandbox functionality)
COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api

# Install required dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    git \
    jq \
    libseccomp2 \
    sudo \
    netcat-openbsd \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Set agentsh version (use latest stable)
ARG AGENTSH_VERSION=0.9.2

# Download and install agentsh
# Use .deb package for Debian-based systems, fall back to tar.gz
RUN set -eux; \
    ARCH=$(uname -m); \
    case "$ARCH" in \
        x86_64) ARCH_NAME="amd64" ;; \
        aarch64) ARCH_NAME="arm64" ;; \
        *) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
    esac; \
    # Try to download .deb first, fall back to tar.gz
    if curl -fsSL -o /tmp/agentsh.deb "https://github.com/canyonroad/agentsh/releases/download/v${AGENTSH_VERSION}/agentsh_${AGENTSH_VERSION}_linux_${ARCH_NAME}.deb" 2>/dev/null; then \
        dpkg -i /tmp/agentsh.deb || apt-get install -f -y; \
        rm /tmp/agentsh.deb; \
    else \
        # Fall back to tar.gz binary installation
        curl -fsSL "https://github.com/canyonroad/agentsh/releases/download/v${AGENTSH_VERSION}/agentsh_${AGENTSH_VERSION}_linux_${ARCH_NAME}.tar.gz" -o /tmp/agentsh.tar.gz; \
        tar -xzf /tmp/agentsh.tar.gz -C /tmp; \
        install -m 0755 /tmp/agentsh /usr/local/bin/agentsh; \
        install -m 0755 /tmp/agentsh-shell-shim /usr/local/bin/agentsh-shell-shim 2>/dev/null || true; \
        install -m 0755 /tmp/agentsh-unixwrap /usr/local/bin/agentsh-unixwrap 2>/dev/null || true; \
        install -m 0755 /tmp/libenvshim.so /usr/local/lib/libenvshim.so 2>/dev/null || true; \
        rm -rf /tmp/agentsh*; \
    fi

# Verify agentsh installation
RUN agentsh --version || echo "agentsh installation verification"

# Create agentsh directories
RUN mkdir -p /etc/agentsh/policies \
             /var/lib/agentsh/quarantine \
             /var/lib/agentsh/sessions \
             /var/log/agentsh

# Copy agentsh configuration files (BEFORE shim installation)
# Paths relative to build context (project root)
COPY config.yaml /etc/agentsh/config.yaml
COPY default.yaml /etc/agentsh/policies/default.yaml

# Set proper permissions
RUN chmod 755 /etc/agentsh /etc/agentsh/policies \
    && chmod 644 /etc/agentsh/config.yaml /etc/agentsh/policies/default.yaml \
    && chmod 755 /var/lib/agentsh /var/lib/agentsh/quarantine /var/lib/agentsh/sessions /var/log/agentsh \
    && chmod 755 /usr/local/bin/sandbox-api

# Set up working directory
WORKDIR /app

# Copy entrypoint script (from debian subdirectory)
COPY debian/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose ports
# 8080: Blaxel sandbox API
# 18080: agentsh server
EXPOSE 8080 18080

# Set environment variables
ENV AGENTSH_SERVER=http://127.0.0.1:18080
ENV PATH="/usr/local/bin:$PATH"

# Install shell shim LAST - this replaces /bin/sh and /bin/bash
# After this point, all shell commands go through the shim
# NOTE: This must be the final RUN command!
RUN agentsh shim install-shell \
    --root / \
    --shim /usr/bin/agentsh-shell-shim \
    --bash \
    --i-understand-this-modifies-the-host

ENTRYPOINT ["/entrypoint.sh"]
