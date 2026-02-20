# agentsh + Blaxel

Runtime security governance for AI agents using [agentsh](https://github.com/canyonroad/agentsh) v0.10.2 with [Blaxel](https://blaxel.ai) sandboxes.

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
| Compute isolation | Command blocking (seccomp) |
| Process sandboxing | File I/O policy (FUSE) |
| API access to sandbox | Domain allowlist/blocklist |
| Persistent environment | Cloud metadata blocking |
| | Environment variable filtering |
| | Secret detection and redaction (DLP) |
| | Bash builtin interception |
| | LLM request auditing |
| | Complete audit logging |

### Key Security Features

| Feature | Description | Status |
|---------|-------------|--------|
| **Command Blocking** | Block dangerous commands (sudo, ssh, kill, rm -rf) via seccomp | Working |
| **Network Policy** | Block cloud metadata, private networks; allow specific domains | Working |
| **File I/O Policy** | FUSE-based file access control with soft-delete quarantine | Working |
| **Environment Filtering** | Block secret env vars (API keys, tokens, credentials) | Working |
| **Bash Builtin Blocking** | Disable dangerous builtins (kill, enable, ulimit) via BASH_ENV | Working |
| **DLP** | Redact PII and secrets from outputs | Working |
| **LLM Proxy** | Intercept and audit LLM API requests | Working |
| **Audit Logging** | Complete visibility into agent operations | Working |

### Security Capabilities in Blaxel

Running `agentsh detect` inside a Blaxel sandbox shows full security mode:

```
$ agentsh detect
Platform: linux
Security Mode: full
Protection Score: 100%

CAPABILITIES
----------------------------------------
  capabilities_drop        ✓
  cgroups_v2               ✓
  ebpf                     ✓
  fuse                     ✓  (file I/O policy enforcement)
  landlock                 -
  landlock_abi             ✓ (v0)
  landlock_network         -
  pid_namespace            -
  seccomp                  ✓
  seccomp_basic            ✓
  seccomp_user_notify      ✓  (command blocking via execve interception)
```

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

### 2. Run the Demo

```bash
# Run the policy enforcement demo
npx tsx demo-blocking.ts
```

The demo runs commands directly through the sandbox — the agentsh shell shim (`/bin/sh`) automatically intercepts every command and enforces policy at the seccomp/execve level. No explicit `agentsh exec` calls needed.

### 3. Run the Full Test Suite

```bash
npx tsx test-debian.ts
```

### Alpine Variant

An Alpine Linux variant is available for smaller image sizes with **full security parity**:

| Feature | Debian | Alpine |
|---------|--------|--------|
| Shell shim interception | Yes | Yes |
| Command blocking (seccomp) | Yes | Yes |
| File I/O policy (FUSE) | Yes | Yes |
| Network policy | Yes | Yes |
| DLP/secret redaction | Yes | Yes |
| Audit logging | Yes | Yes |
| BASH_ENV builtin blocking | Yes | Yes |
| Image size | ~450MB | ~200MB |
| Architecture support | amd64, arm64 | amd64 only |

**How does the shell shim work on Alpine/BusyBox?** BusyBox uses `argv[0]` for applet detection, but `agentsh exec` runs `/bin/sh.real` with `argv[0]="sh.real"` — which BusyBox doesn't recognize. The fix: replace the BusyBox `/bin/sh` symlink with a link to bash *before* shim install (`rm -f /bin/sh && ln -s /bin/bash /bin/sh`). The installer then copies bash (not BusyBox) to `/bin/sh.real`. Bash ignores `argv[0]`, so it works correctly regardless of how it's invoked.

```bash
# Deploy Alpine version
# Blaxel always uses ./blaxel.toml and ./Dockerfile — swap both:
cp blaxel.toml blaxel.toml.bak && cp blaxel-alpine.toml blaxel.toml
cp Dockerfile Dockerfile.bak && cp Dockerfile.alpine Dockerfile
bl deploy
mv blaxel.toml.bak blaxel.toml
mv Dockerfile.bak Dockerfile

# Or just run the test script (auto-deploys if needed):
npx tsx test-alpine.ts
```

**Recommendation:** Use Debian for production (arm64 support, larger ecosystem). Use Alpine for smaller images (amd64 only).

Expected output from `demo-blocking.ts`:
```
AGENTSH POLICY BLOCKING DEMO
============================================================
agentsh version: agentsh 0.10.2+...
Shell shim active: commands enforced via /bin/sh interception

1. ALLOWED COMMANDS
  ✓ echo Hello          → ALLOWED (exit: 0)
  ✓ pwd                 → ALLOWED (exit: 0)
  ✓ ls, date, cat       → ALLOWED (exit: 0)

2. BLOCKED: Privilege Escalation
  ✗ sudo whoami         → BLOCKED by block-shell-escape (exit: 126)
  ✗ su -                → BLOCKED by block-shell-escape (exit: 126)

3. BLOCKED: Network Tools
  ✗ ssh localhost        → BLOCKED by block-network-tools (exit: 126)

4. BLOCKED: System Commands
  ✗ kill -9 1            → BLOCKED by block-system-commands (exit: 126)
  ✗ shutdown now         → BLOCKED by block-system-commands (exit: 126)

5. BLOCKED: Recursive Delete
  ✗ rm -rf /tmp/test     → BLOCKED by block-rm-recursive (exit: 126)

6. ALLOWED: Single File Delete
  ✓ rm /tmp/test/file    → ALLOWED (exit: 0)

7. AUDIT TRAIL (recent blocked events)
  ✗ /bin/rm -rf /tmp/test   rule: block-rm-recursive
  ✗ /usr/bin/sudo whoami     rule: block-shell-escape
  ...
```

Expected output from `test-debian.ts`:
```
AGENTSH-BLAXEL DEBIAN TEST
============================================================

=== Test Suite: agentsh Installation ===
  agentsh installed... ✓ PASS
  CGO/libseccomp support... ✓ PASS

=== Test Suite: Server Health ===
  agentsh server healthy... ✓ PASS

=== Test Suite: Configuration ===
  policy file exists... ✓ PASS
  config file exists... ✓ PASS

=== Test Suite: Shell Shim ===
  echo through shim... ✓ PASS
  file listing through shim... ✓ PASS
  bash execution through shim... ✓ PASS

=== Test Suite: Policy Enforcement ===
  sudo blocked (exit 126)... ✓ PASS
  ssh blocked (exit 126)... ✓ PASS
  kill blocked (exit 126)... ✓ PASS
  rm -rf blocked (exit 126)... ✓ PASS
  echo allowed (exit 0)... ✓ PASS

=== Test Suite: Network Policy ===
  allowed domain (github.com)... ✓ PASS
  metadata endpoint blocked... ✓ PASS

=== Test Suite: Environment Policy ===
  env filtered to safe vars only... ✓ PASS
  BASH_ENV passed through... ✓ PASS
  policy-test: sudo denied... ✓ PASS
  policy-test: echo allowed... ✓ PASS

=== Test Suite: File I/O Policy ===
  policy-test: workspace write allowed... ✓ PASS
  policy-test: workspace read allowed... ✓ PASS
  policy-test: tmp write allowed... ✓ PASS
  policy-test: workspace delete is soft-delete... ✓ PASS
  policy-test: SSH key access denied... ✓ PASS
  policy-test: AWS credentials denied... ✓ PASS
  policy-test: system path write denied... ✓ PASS
  policy-test: /etc write denied... ✓ PASS
  write to /app succeeds... ✓ PASS
  write to /tmp succeeds... ✓ PASS
  read system files succeeds... ✓ PASS

Total: 30 passed / 0 failed
```

## Project Structure

```
agentsh-blaxel/
├── blaxel.toml          # Blaxel configuration (default: Debian)
├── blaxel-alpine.toml   # Blaxel configuration (Alpine)
├── Dockerfile           # Debian container with agentsh + shell shim
├── Dockerfile.alpine    # Alpine container with agentsh + shell shim (BusyBox fix)
├── debian/              # Debian-specific files
│   └── entrypoint.sh    # Startup script (session pre-creation + AGENTSH_SHIM_FORCE)
├── alpine/              # Alpine-specific files
│   └── entrypoint.sh    # Startup script (same pattern as Debian, uses bash.real)
├── config.yaml          # agentsh server configuration (shared)
│                        # - Network interception settings
│                        # - DLP patterns
│                        # - LLM proxy settings
│                        # - env_inject (BASH_ENV for builtin blocking)
│                        # - FUSE file I/O settings
├── default.yaml         # Security policy rules (shared)
│                        # - file_rules (FUSE file I/O)
│                        # - network_rules
│                        # - command_rules
│                        # - env_policy
├── sandbox-utils.ts     # Shared sandbox API utilities
├── demo-blocking.ts     # Policy blocking demo (shell shim)
├── test-debian.ts       # Security test suite (Debian, 30 tests)
├── test-alpine.ts       # Security test suite (Alpine, 32 tests)
└── package.json         # Node.js dependencies
```

## Security Policy Details

### File I/O Rules (`file_rules`)

FUSE-based file access control intercepts file operations at the filesystem level. Requires the `fuse3` package.

**Workspace (`/app`):**
- Read/write/create allowed
- Deletes use **soft-delete** — files are quarantined to `/var/lib/agentsh/quarantine/` and can be recovered

**Temp directories (`/tmp`, `/var/tmp`):**
- Full access

**System paths (`/usr`, `/lib`, `/bin`, `/etc`):**
- Read-only

**Blocked paths:**
- `/root/.ssh/**` — SSH keys
- `/root/.aws/**` — AWS credentials
- `/root/.env*` — Environment files

**Important:** The policy must include an `allow-stat-everywhere` rule permitting `stat`, `list`, and `readlink` on all paths (`**`), placed before the default-deny. Without this, FUSE stat calls cause all commands to fail with exit 127.

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

See the [agentsh DLP documentation](https://www.agentsh.org/docs/#llm-proxy) for more details on Data Loss Prevention and LLM request auditing.

## Blaxel-Specific Protections

agentsh provides additional security for Blaxel sandboxes beyond standard isolation:

| Threat | Without agentsh | With agentsh |
|--------|-----------------|--------------|
| **Process history disclosure** | Agents can list all processes via `localhost:8080/process` | **Not mitigated** (see below) |
| **Internal DNS probing** | Agents could enumerate Blaxel's internal DNS (172.16.x.x) | Private network ranges blocked |
| **Sandbox-api manipulation** | Direct API calls could bypass intended workflows | **Partially mitigated** — commands routed through agentsh policy, but sandbox-api is still reachable |
| **Signal attacks** | Bash `kill` builtin could signal sandbox-api/agentsh | Builtins disabled via BASH_ENV; `/bin/kill` blocked by command policy |
| **Cloud credential theft** | Agents could access 169.254.169.254 metadata | Metadata endpoint blocked |

### Blocking Internal API Access

**Known limitation:** agentsh network policy does not intercept loopback connections (`127.0.0.1`). All processes in the Blaxel container run as root, so iptables owner-based rules cannot distinguish agent commands from system daemons.

Agents can directly access Blaxel's sandbox-api on `localhost:8080`, which leaks process history. Mitigations require changes at the Blaxel platform level (e.g., sandbox-api authentication for local requests, Unix socket instead of TCP, or running agent commands as a non-root user).

## Architecture

The shell shim is the key integration point. agentsh replaces `/bin/sh` and `/bin/bash` with a shim that routes every command through the agentsh policy engine:

```
sandbox-api runs: /bin/sh -c "sudo whoami"
                     │
                     ▼
            ┌─────────────────┐
            │  Shell Shim     │  /bin/sh → agentsh-shell-shim
            │  (intercepts)   │  AGENTSH_SHIM_FORCE=1 overrides
            └────────┬────────┘  non-TTY bypass (v0.10.1+)
                     │
                     ▼
            ┌─────────────────┐
            │  agentsh exec   │  Uses pre-created session
            │  (seccomp +     │  (AGENTSH_SESSION_ID from entrypoint)
            │   unixwrap)     │
            └────────┬────────┘
                     │
              ┌──────┴──────┐
              ▼             ▼
        ┌──────────┐  ┌──────────┐
        │  ALLOW   │  │  BLOCK   │
        │ exit: 0  │  │ exit: 126│
        └──────────┘  └──────────┘
```

### Entrypoint Startup Sequence (Debian)

The entrypoint must start services in a specific order:

1. **Start agentsh server** — the shell shim needs the server running
2. **Pre-create a session** — `agentsh session create --policy default --json`
3. **Export `AGENTSH_SHIM_FORCE=1` and `AGENTSH_SESSION_ID`** — so sandbox-api inherits them
4. **Start sandbox-api** — commands now go through the shim with policy enforcement

**Why this order matters:** In agentsh 0.10.1+, the shell shim bypasses enforcement when stdin is not a TTY (to avoid corrupting binary data in pipes). Since Blaxel's sandbox-api runs commands without a TTY, `AGENTSH_SHIM_FORCE=1` overrides this bypass. The session must be pre-created before sandbox-api starts — otherwise the shim's session auto-creation can block on first command.

Full system view:

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
npx tsx test-debian.ts
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
| `AGENTSH_SHIM_FORCE` | Force shell shim enforcement even without TTY (set by entrypoint) | Not set |
| `AGENTSH_SESSION_ID` | Pre-created session ID for the shell shim (set by entrypoint) | Not set |

## Related Projects

- [agentsh](https://github.com/canyonroad/agentsh) - Runtime security for AI agents
- [Blaxel](https://blaxel.ai) - Perpetual sandbox platform

## License

MIT
