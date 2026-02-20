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

agentsh adds the governance layer that controls what agents can do inside the sandbox, providing defense-in-depth:

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

## What agentsh Adds

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

## Quick Start

### Prerequisites

- [Blaxel CLI](https://docs.blaxel.ai) installed and authenticated (`bl login`)
- Node.js 18+

### Deploy and Test

```bash
git clone https://github.com/canyonroad/agentsh-blaxel
cd agentsh-blaxel
npm install
bl deploy

# Run the policy enforcement demo
npx tsx demo-blocking.ts

# Run the full test suite (30 tests)
npx tsx test-debian.ts
```

**Alpine variant:** An Alpine Linux variant is available with full security parity and smaller image sizes (~200MB vs ~450MB, amd64 only). Run `npx tsx test-alpine.ts` to auto-deploy and test it.

## How It Works

agentsh replaces `/bin/sh` and `/bin/bash` with a [shell shim](https://www.agentsh.org/docs/#shell-shim) that routes every command through the policy engine:

```
sandbox-api runs: /bin/sh -c "sudo whoami"
                     │
                     ▼
            ┌─────────────────┐
            │  Shell Shim     │  /bin/sh → agentsh-shell-shim
            │  (intercepts)   │
            └────────┬────────┘
                     │
                     ▼
            ┌─────────────────┐
            │  agentsh exec   │  Policy evaluation via
            │  (seccomp)      │  seccomp execve interception
            └────────┬────────┘
                     │
              ┌──────┴──────┐
              ▼             ▼
        ┌──────────┐  ┌──────────┐
        │  ALLOW   │  │  BLOCK   │
        │ exit: 0  │  │ exit: 126│
        └──────────┘  └──────────┘
```

Every command that Blaxel's sandbox-api executes is automatically intercepted — no explicit `agentsh exec` calls needed.

## Configuration

Security policy is defined in two files:

- **`config.yaml`** — Server configuration: network interception, [DLP patterns](https://www.agentsh.org/docs/#llm-proxy), LLM proxy, FUSE settings, [env_inject](https://www.agentsh.org/docs/#shell-shim) (BASH_ENV for builtin blocking)
- **`default.yaml`** — [Policy rules](https://www.agentsh.org/docs/#policy-reference): [command rules](https://www.agentsh.org/docs/#command-rules), [network rules](https://www.agentsh.org/docs/#network-rules), [file rules](https://www.agentsh.org/docs/#file-rules), [environment policy](https://www.agentsh.org/docs/#environment-policy)

See the [agentsh documentation](https://www.agentsh.org/docs/) for the full policy reference.

## Project Structure

```
agentsh-blaxel/
├── blaxel.toml
├── blaxel-alpine.toml
├── Dockerfile
├── Dockerfile.alpine
├── debian/
│   └── entrypoint.sh
├── alpine/
│   └── entrypoint.sh
├── config.yaml
├── default.yaml
├── sandbox-utils.ts
├── demo-blocking.ts
├── test-debian.ts
├── test-alpine.ts
└── package.json
```

## Testing

```bash
npx tsx test-debian.ts    # Debian test suite (30 tests)
npx tsx test-alpine.ts    # Alpine test suite (32 tests, auto-deploys)
```

## Related Projects

- [agentsh](https://github.com/canyonroad/agentsh) — Runtime security for AI agents ([docs](https://www.agentsh.org/docs/))
- [Blaxel](https://blaxel.ai) — Perpetual sandbox platform

## License

MIT
