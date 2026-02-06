# agentsh-blaxel Project Notes

## Project Overview

agentsh runtime security integrated with Blaxel sandboxes. Deploys a Debian (or Alpine) container with agentsh providing policy enforcement for AI agent commands.

## Key Architecture: Shell Shim

The shell shim is the core integration mechanism. It replaces `/bin/sh` and `/bin/bash` with `agentsh-shell-shim`, so every command the Blaxel sandbox-api runs is automatically intercepted by agentsh.

**Flow:**
1. Blaxel sandbox-api runs `/bin/sh -c "<command>"`
2. Shell shim intercepts (it IS `/bin/sh`) and wraps in `agentsh exec --session-file <cached-sid> -- /bin/sh.real -c "<command>"`
3. agentsh enforces policy via seccomp execve interception
4. Blocked commands get exit code 126; allowed commands run normally

**Critical lesson (learned 2026-02-05):** Do NOT call `agentsh exec` explicitly when the shell shim is active. The shim already wraps every command in `agentsh exec`. Calling it explicitly causes nested wrapping (`agentsh exec` inside `agentsh exec`) which hangs in agentsh 0.9.2+. The old `demo-blocking.ts` had this bug — it was fixed by running commands directly and letting the shim handle enforcement.

## Deploying and Testing

```bash
bl deploy                    # Deploy Debian variant
bl deploy -f blaxel-alpine.toml  # Deploy Alpine variant
npx tsx demo-blocking.ts     # Policy enforcement demo
npx tsx test-template.ts     # Full test suite
bl delete sandbox agentsh-blaxel  # Clean up
```

**Cold start timing:** After `bl deploy`, the sandbox needs ~60 seconds before commands work. A 30-second wait is not enough — the pod takes time to provision and the Blaxel service needs to register. If commands fail with "No healthy pods available" / 404, wait longer and retry. Once the first command succeeds, subsequent commands are fast.

## Version History

- **0.9.2** (current) - Shell shim works, `agentsh exec` CLI hangs when nested through shim. Demo uses direct commands + events query API for policy rule names.
- **0.8.10** (previous) - Nested `agentsh exec` through shim worked (or appeared to).

## How Policy Blocking Manifests

- **Exit 126** = command blocked by seccomp policy (the binary exists but execve is denied)
- **Exit 127** = command not found (may also be seccomp blocking when using bare command names without full path)
- stderr shows confusing messages like "Success" or "No child processes" — these are seccomp errno artifacts, not real errors
- Use `agentsh events query --decision deny --type execve` to get the actual policy rule names

## agentsh HTTP API (inside sandbox)

The agentsh server listens on `http://127.0.0.1:18080`. Useful endpoints:
- `GET /health` — health check
- `POST /api/v1/sessions/{id}/exec` — execute command in session (returns structured JSON with policy decisions)
- Events query via CLI: `/usr/bin/agentsh events query --decision deny --type execve --limit 10`

When querying APIs from inside the sandbox, use `/usr/bin/agentsh` (full path) to avoid ambiguity.

## File Layout

- `Dockerfile` / `Dockerfile.alpine` — Container definitions, `AGENTSH_VERSION` ARG sets the version
- `config.yaml` — agentsh server config (security mode, DLP patterns, proxy, env_inject)
- `default.yaml` — Security policy (file_rules, network_rules, command_rules, env_policy)
- `debian/entrypoint.sh` — Uses `#!/bin/bash.real` (not `/bin/bash`) because bash IS the shim
- `demo-blocking.ts` — Runs commands directly through sandbox API, checks exit codes, queries events for rule names
- `test-template.ts` / `test-alpine.ts` — Full test suites

## Alpine Limitations

Alpine uses BusyBox which determines applets by argv[0]. Renaming `/bin/sh` to `/bin/sh.real` breaks BusyBox entirely, so the shell shim cannot be installed on Alpine. Alpine variant has no automatic command interception.
