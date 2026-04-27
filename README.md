# agentsh + Blaxel

Runtime security governance for AI agents using [agentsh](https://github.com/canyonroad/agentsh) v0.18.3 with [Blaxel](https://blaxel.ai) sandboxes.

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
| | Security hardening (credential removal, persistence vector cleanup) |

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

# Run the Agent Sandbox Taxonomy (AST) benchmark
npx tsx test-taxonomy.ts
```

**Alpine variant:** An Alpine Linux variant is available with full security parity and smaller image sizes (~200MB vs ~450MB). The `0.18.3` musl release supports both `amd64` and `arm64`. Run `npx tsx test-alpine.ts` to auto-deploy and test it.

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
├── test-taxonomy.ts
└── package.json
```

## Testing

```bash
npx tsx test-debian.ts    # Debian test suite (30 tests)
npx tsx test-alpine.ts    # Alpine test suite (32 tests, auto-deploys)
npx tsx test-taxonomy.ts  # AST benchmark (15/28, 54%)
```

## Current Blaxel Protection Level

On the current Blaxel runtime, `agentsh detect` reports the same result for both Debian and Alpine sandboxes:

```text
Security Mode:    minimal
Protection Score: 50/100
```

That means the policy layer in this repo is working, but the runtime is not yet exposing the Linux primitives that let agentsh move into stronger kernel-enforced modes. The main gaps observed on Blaxel are:

- No `cgroups v2`, so agentsh cannot enforce resource limits and cannot attach its stronger network controls
- No `eBPF` support, so there is no kernel-level connection tracking or network policy backend
- No PID namespace isolation, so processes still share the host namespace view
- Full capability sets retained, so the container is not starting from a least-privilege baseline

The AST benchmark on the current Blaxel runtime scores `15/28 (54%)`, which lines up with the `minimal` detect result.

## Blaxel Hardening Guide

If Blaxel engineering wants stronger protection with agentsh, these are the highest-value runtime changes to add or enable:

- Enable `cgroups v2`. This is the biggest missing primitive because it unlocks agentsh resource controls and is a prerequisite for stronger network enforcement.
- Expose `seccomp user-notify` support in the sandbox runtime. That lets agentsh use its full seccomp enforcement path instead of falling back to the current minimal posture.
- Expose `eBPF` support with the required capabilities. That is the path to kernel-level network visibility and policy enforcement.
- Add PID namespace isolation for sandbox workloads so processes do not share the host PID namespace.
- Drop Linux capabilities by default and keep only the minimum set required. If ptrace mode is needed as a fallback, grant only `SYS_PTRACE` rather than leaving the full bounding set available.
- Support kernel `6.7+` / Landlock ABI v4 if Blaxel wants TCP connect/bind restrictions without relying entirely on eBPF.
- Run the workload as a non-root user where possible, and tighten exposure of `/proc` and sensitive system files such as `/etc/shadow`, `/etc/sudoers`, `/proc/1/root`, and `/proc/sysrq-trigger`.
- Block raw socket creation unless the sandbox explicitly needs it.
- Route outbound LLM and API traffic through the agentsh proxy and declare `http_services` so external access is governed consistently in every security mode.

### Networking Note

Ptrace can improve network enforcement only as its own fallback mode. It is not an extra networking layer that can be stacked on top of the current seccomp path in agentsh `0.18.3`.

- If Blaxel adds `SYS_PTRACE` but not seccomp user-notify, agentsh can run in `ptrace` mode and intercept `connect` / `bind` syscalls.
- That is still weaker than full seccomp + eBPF mode, and ptrace DNS/SNI interception remains best-effort rather than a hard security boundary.
- For the strongest network protections, the right target for Blaxel is `cgroups v2` + `eBPF`, with seccomp user-notify enabled.

## Related Projects

- [agentsh](https://github.com/canyonroad/agentsh) — Runtime security for AI agents ([docs](https://www.agentsh.org/docs/))
- [Blaxel](https://blaxel.ai) — Perpetual sandbox platform

## License

MIT
