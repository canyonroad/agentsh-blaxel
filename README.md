# agentsh + Blaxel

Runtime security governance for AI agents using [agentsh](https://github.com/canyonroad/agentsh) with [Blaxel](https://blaxel.ai) sandboxes.

## Why agentsh + Blaxel?

**Blaxel provides isolation. agentsh provides governance.**

Blaxel sandboxes give AI agents a secure, isolated compute environment. But isolation alone doesn't prevent an agent from:

- **Exfiltrating data** to unauthorized endpoints
- **Accessing cloud metadata** (AWS/GCP/Azure credentials at 169.254.169.254)
- **Leaking secrets** in outputs (API keys, tokens, PII)
- **Running dangerous commands** (sudo, ssh, kill, nc)
- **Reaching internal networks** (10.x, 172.16.x, 192.168.x)

**agentsh adds the security governance layer** that controls what agents can do inside the sandbox, providing defense-in-depth:

```
┌─────────────────────────────────────────────────────────┐
│  Blaxel Sandbox (Isolation)                             │
│  ┌───────────────────────────────────────────────────┐  │
│  │  agentsh (Governance)                             │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  AI Agent                                   │  │  │
│  │  │  - Commands are policy-checked              │  │  │
│  │  │  - Network requests are filtered            │  │  │
│  │  │  - Secrets are redacted from output         │  │  │
│  │  │  - All actions are audited                  │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## What agentsh Adds to Blaxel

| Blaxel Provides | agentsh Adds |
|-----------------|--------------|
| Compute isolation | Network policy enforcement |
| Process sandboxing | Domain allowlist/blocklist |
| API access to sandbox | Cloud metadata blocking |
| Persistent environment | Environment variable filtering |
| | Secret detection and redaction (DLP) |
| | Dangerous command blocking |
| | Bash builtin interception |
| | LLM request auditing |
| | Complete audit logging |

### Key Security Features

| Feature | Description | Status |
|---------|-------------|--------|
| **Network Policy** | Block cloud metadata, private networks; allow specific domains | Working |
| **Policy Evaluation** | Define rules for commands, files, network access | Working |
| **Environment Filtering** | Block secret env vars (API keys, tokens, credentials) | Working |
| **Bash Builtin Blocking** | Disable dangerous builtins (kill, enable, ulimit) via BASH_ENV | Working |
| **DLP** | Redact PII and secrets from outputs | Working |
| **LLM Proxy** | Intercept and audit LLM API requests | Working |
| **Audit Logging** | Complete visibility into agent operations | Working |
| **Command Rules** | Policy correctly identifies blocked commands | Working |

## Quick Start

### Prerequisites

- [Blaxel CLI](https://docs.blaxel.ai) installed and authenticated (`bl login`)
- Node.js 18+

### 1. Deploy to Blaxel

```bash
# Clone and deploy
git clone https://github.com/canyonroad/agentsh-blaxel
cd agentsh-blaxel
npm install
bl deploy
```

### 2. Run the Tests

```bash
# Run the security test suite
npx tsx test-template.ts
```

Expected output:
```
agentsh + Blaxel: Security Feature Tests
============================================================
TEST SUITE 1: Network Policy
  npm registry (allowed) - PASS
  GitHub API (allowed) - PASS
  AWS metadata (blocked) - PASS
  Private network (blocked) - PASS

TEST SUITE 2: Policy Evaluation
  Policy: sudo should be denied - PASS
  Policy: ssh should be denied - PASS
  Policy: echo should be allowed - PASS
  ...

Total tests: 14
Passed: 14
Success rate: 100.0%
```

## Project Structure

```
agentsh-blaxel/
├── Dockerfile           # Container with agentsh + Blaxel sandbox-api
├── blaxel.toml          # Blaxel sandbox configuration
├── entrypoint.sh        # Startup script
├── config.yaml          # agentsh server configuration
│                        # - Network interception settings
│                        # - DLP patterns
│                        # - LLM proxy settings
│                        # - env_inject (BASH_ENV for builtin blocking)
├── default.yaml         # Security policy rules
│                        # - file_rules
│                        # - network_rules
│                        # - command_rules
│                        # - env_policy
├── test-template.ts     # Security test suite
└── package.json         # Node.js dependencies
```

## Security Policy Details

### Network Rules (`network_rules`)

**Allowed Destinations:**
- Package registries: npm, PyPI, Cargo, Go proxy
- Code hosting: GitHub API, raw.githubusercontent.com

**Blocked Destinations:**
- Cloud metadata: `169.254.169.254` (AWS/GCP/Azure)
- Private networks: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Link-local: `169.254.0.0/16`

### Command Rules (`command_rules`)

The policy correctly identifies which commands should be allowed or denied:

**Allowed:**
- Safe utilities: `echo`, `ls`, `cat`, `grep`, `find`, `pwd`
- Dev tools: `node`, `npm`, `python`, `pip`, `git`, `curl`

**Denied (policy evaluation):**
- Privilege escalation: `sudo`, `su`, `chroot`
- Raw network tools: `nc`, `ssh`, `telnet`
- System commands: `shutdown`, `reboot`, `mount`
- Signal commands: `kill` (also blocked as bash builtin via BASH_ENV)

### Environment Policy (`env_policy`)

**Allowed Variables:**
```
PATH, HOME, LANG, TERM, USER, SHELL, PWD, TZ
CI, CI_*  (for CI environments)
AGENTSH_*  (internal)
BASH_ENV  (used internally to disable dangerous builtins)
```

**Blocked Variables:**
```
AWS_*, AZURE_*, GOOGLE_*     # Cloud credentials
*_SECRET*, *_TOKEN, *_KEY    # Secrets
OPENAI_*, ANTHROPIC_*        # API keys
LD_PRELOAD, LD_LIBRARY_PATH  # Dynamic linker injection
PROMPT_COMMAND               # Shell injection vectors
```

### Bash Builtin Blocking (`env_inject`)

Bash has built-in commands like `kill` that bypass seccomp syscall interception. agentsh uses the `env_inject` configuration to set `BASH_ENV`, which sources a startup script that disables dangerous builtins:

**Disabled builtins:**
- `kill` - Signal sending (falls back to `/bin/kill` which is policy-controlled)
- `enable` - Prevents re-enabling disabled builtins
- `ulimit` - Resource limit manipulation
- `umask` - File permission mask changes
- `builtin` - Force builtin execution bypass
- `command` - Function/alias bypass

This is configured in `config.yaml`:
```yaml
sandbox:
  env_inject:
    BASH_ENV: "/usr/lib/agentsh/bash_startup.sh"
```

When an AI agent runs `bash -c "kill -9 1"`, the builtin is disabled and it falls back to `/bin/kill`, which is then blocked by the command policy.

### DLP Patterns (config.yaml)

Automatically detects and redacts:
- OpenAI/Anthropic API keys
- AWS access keys
- GitHub tokens (PAT, OAuth)
- JWT tokens
- Private keys (PEM format)
- Database URLs
- Bearer tokens

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Blaxel Sandbox                                              │
│  ┌───────────────┐                                          │
│  │ sandbox-api   │◀── Blaxel platform process API           │
│  └───────────────┘                                          │
│          │                                                  │
│          ▼                                                  │
│  ┌───────────────┐    ┌──────────────────────────────────┐ │
│  │  AI Agent     │───▶│  agentsh Policy Engine           │ │
│  │  Commands     │    │                                  │ │
│  └───────────────┘    │  ┌─────────┐  ┌─────────┐       │ │
│                       │  │ network │  │ env     │       │ │
│                       │  │ proxy   │  │ filter  │       │ │
│                       │  └─────────┘  └─────────┘       │ │
│                       │  ┌─────────┐  ┌─────────┐       │ │
│                       │  │ DLP     │  │ audit   │       │ │
│                       │  │ redact  │  │ log     │       │ │
│                       │  └─────────┘  └─────────┘       │ │
│                       └──────────────────────────────────┘ │
│                                  │                         │
│                    ┌─────────────┴─────────────┐          │
│                    ▼                           ▼          │
│              ┌──────────┐               ┌──────────┐      │
│              │  ALLOW   │               │  BLOCK   │      │
│              │ (GitHub) │               │ (169.254)│      │
│              └──────────┘               └──────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## Customization

### Modify Network Policy

Edit `default.yaml`:

```yaml
network_rules:
  # Add a new allowed domain
  - name: allow-my-api
    domains:
      - "api.myservice.com"
    ports: [443]
    decision: allow

  # Block a specific domain
  - name: block-competitor
    domains:
      - "competitor.com"
    decision: deny
```

### Add DLP Patterns

Edit `config.yaml`:

```yaml
dlp:
  custom_patterns:
    - name: my_internal_key
      display: "[INTERNAL_KEY]"
      regex: "internal-[a-zA-Z0-9]{32}"
      action: redact
```

### Adjust Resource Limits

Edit `default.yaml`:

```yaml
resource_limits:
  max_memory_mb: 4096      # Increase memory
  cpu_quota_percent: 80    # More CPU
  command_timeout: 10m     # Longer timeout
```

## Testing

Run the full test suite:

```bash
npx tsx test-template.ts
```

Test individual features:

```bash
# Test network blocking
curl -s --connect-timeout 3 http://169.254.169.254/  # Should fail

# Test allowed network
curl -s https://api.github.com/  # Should work

# Test policy evaluation
agentsh debug policy-test --op exec --path sudo --json
# Returns: {"decision": "deny", "rule": "block-shell-escape"}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BL_SANDBOX_URL` | Sandbox URL for tests | Auto-detected |
| `BL_ACCESS_TOKEN` | Blaxel access token | From `~/.blaxel/config.yaml` |
| `AGENTSH_SERVER` | agentsh server URL | `http://127.0.0.1:18080` |

## Related Projects

- [agentsh](https://github.com/canyonroad/agentsh) - Runtime security for AI agents
- [Blaxel](https://blaxel.ai) - Perpetual sandbox platform

## License

MIT
