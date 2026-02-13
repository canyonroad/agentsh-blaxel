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
npx tsx demo-blocking.ts     # Policy enforcement demo
npx tsx test-debian.ts     # Full test suite (30/30 pass)
npx tsx test-alpine.ts       # Alpine test suite (16/16 pass, auto-deploys)
bl delete sandbox agentsh-blaxel  # Clean up
```

**Blaxel deploy:** `bl deploy` always reads `./blaxel.toml` and `./Dockerfile`. There is NO `-f` flag. To deploy the Alpine variant, swap both files (the test-alpine.ts script does this automatically). The `dockerfile` field in blaxel.toml is not supported — it is silently ignored.

**Cold start timing:** After `bl deploy`, the sandbox needs ~60 seconds before commands work. A 30-second wait is not enough — the pod takes time to provision and the Blaxel service needs to register. If commands fail with "No healthy pods available" / 404, wait longer and retry. Once the first command succeeds, subsequent commands are fast.

## Version History

- **0.9.8** (current) - FUSE file I/O enforcement working (requires `fuse3` package). Shell shim works, `agentsh exec` CLI hangs when nested through shim. Demo uses direct commands + events query API for policy rule names.
- **0.9.2** (previous) - Shell shim works, `agentsh exec` CLI hangs when nested through shim. FUSE not working (missing `fuse3` package).
- **0.8.10** (legacy) - Nested `agentsh exec` through shim worked (or appeared to).

## FUSE File I/O Enforcement

**Requirement:** The `fuse3` Debian package must be installed for FUSE to work. Without it, the agentsh server silently fails to mount the FUSE filesystem (`fuse_mount_failed` metric). The Go FUSE library needs the `fusermount3` binary.

**How it works:**
- agentsh mounts a FUSE filesystem at `/var/lib/agentsh/sessions/<session-id>/workspace-mnt`
- The workspace maps to `/app` (the agent's working directory)
- FUSE intercepts `file_stat` and `dir_list` operations and checks them against `file_rules`
- Metric `agentsh_events_by_type_total{type="fuse_mounted"}` = 1 confirms FUSE is active

**Critical policy lesson (learned 2026-02-12):** When FUSE is enabled, the `file_rules` default-deny catches `stat` and `list` operations from the FUSE filesystem. Even though FUSE only mounts at the workspace path, it generates many stat calls that hit the policy evaluator. The policy MUST include an `allow-stat-everywhere` rule allowing `stat`, `list`, and `readlink` on `**` (all paths), placed before the default-deny. Without this, ALL commands fail with exit 127 ("agentsh: command failed"). The actual write/create/delete enforcement is handled by path-specific rules above the catchall.

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
- `test-debian.ts` / `test-alpine.ts` — Full test suites

## Alpine Limitations

Alpine uses BusyBox which determines applets by argv[0]. Renaming `/bin/sh` to `/bin/sh.real` breaks BusyBox entirely, so the shell shim cannot be installed on Alpine. Alpine variant has no automatic command interception — commands like `sudo`, `nc`, `kill` are NOT blocked by policy.

What DOES work on Alpine:
- **Network policy** — metadata endpoint blocking, domain allowlist (via agentsh server proxy)
- **BASH_ENV builtin disabling** — bash builtins (kill, enable, ulimit) are disabled, but the fallback binaries still run since there's no seccomp to block them
- **DLP/secret redaction** — via agentsh server
- **Audit logging** — via agentsh server

What does NOT work:
- **Shell shim / seccomp command blocking** — `sudo`, `nc`, `ssh`, `kill` all succeed
- `agentsh --version` shows "agentsh dev" (musl build doesn't embed version)

agentsh installs to `/usr/local/bin/agentsh` on Alpine (not `/usr/bin/` like on Debian .deb packages).
