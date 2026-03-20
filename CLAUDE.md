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

**Non-TTY bypass and AGENTSH_SHIM_FORCE (learned 2026-02-19):** In agentsh 0.10.1+, the shell shim bypasses enforcement when stdin is not a TTY (PR #96). Since Blaxel's sandbox-api always runs commands without a TTY, this breaks policy enforcement. The fix (agentsh 0.10.2+) adds `AGENTSH_SHIM_FORCE=1` env var to override the bypass.

**Critical: Do NOT set AGENTSH_SHIM_FORCE as a Dockerfile ENV.** Setting it globally causes all commands to hang because the very first `/bin/sh` call from sandbox-api tries to route through `agentsh exec` with session auto-creation, which blocks. Instead, the entrypoint must:
1. Start the agentsh server first
2. Pre-create a session with `agentsh session create --policy default --json`
3. Export `AGENTSH_SESSION_ID` and `AGENTSH_SHIM_FORCE=1` so sandbox-api inherits them
This way the shim has a ready session and never needs to auto-create one.

## Deploying and Testing

```bash
bl deploy                    # Deploy Debian variant
npx tsx demo-blocking.ts     # Policy enforcement demo
npx tsx test-debian.ts     # Full test suite (30/30 pass)
npx tsx test-alpine.ts       # Alpine test suite (32/32 pass, auto-deploys)
bl delete sandbox agentsh-blaxel  # Clean up
```

**Blaxel deploy:** `bl deploy` always reads `./blaxel.toml` and `./Dockerfile`. There is NO `-f` flag. To deploy the Alpine variant, swap both files (the test-alpine.ts script does this automatically). The `dockerfile` field in blaxel.toml is not supported — it is silently ignored.

**Cold start timing:** After `bl deploy`, the sandbox needs ~60 seconds before commands work. A 30-second wait is not enough — the pod takes time to provision and the Blaxel service needs to register. If commands fail with "No healthy pods available" / 404, wait longer and retry. Once the first command succeeds, subsequent commands are fast.

## Version History

- **0.16.5** (current) - Introduces `agentsh-stub` binary for exec redirect. Both Dockerfiles must install it (`install -m 0755 /tmp/agentsh-stub /usr/local/bin/agentsh-stub`); without it the server hangs during exec redirect and becomes unresponsive. Multicall binary bypass on Alpine persists from 0.16.4.
- **0.16.4** (previous) - Ed25519 policy signing, ptrace enforcement backend, seccomp file monitor, path canonicalization for execve. Known issue: BusyBox/coreutils multicall binary unwrapping extracts wrong `payload_command` (last arg instead of argv[0]), causing kill/rm bypass on Alpine. Policy evaluation is correct; runtime enforcement fails for multicall binaries.
- **0.10.4** - Performance improvements.
- **0.10.2** - Adds `AGENTSH_SHIM_FORCE=1` env var to override the non-TTY stdin bypass in the shell shim. Required for sandbox platforms (Blaxel, E2B) where commands run without a TTY but still need policy enforcement.

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
- `config.yaml` — agentsh server config (security mode, DLP patterns, proxy, env_inject, FUSE)
- `default.yaml` — Security policy (file_rules, network_rules, command_rules, env_policy)
- `debian/entrypoint.sh` — Uses `#!/bin/bash.real` (not `/bin/bash`) because bash IS the shim. Pre-creates session and exports `AGENTSH_SHIM_FORCE=1`.
- `alpine/entrypoint.sh` — Uses `#!/bin/bash.real` (same as Debian). Pre-creates session and exports `AGENTSH_SHIM_FORCE=1`.
- `sandbox-utils.ts` — Shared sandbox API utilities (command exec, deploy helpers)
- `demo-blocking.ts` — Runs commands directly through sandbox API, checks exit codes, queries events for rule names
- `test-debian.ts` / `test-alpine.ts` — Full test suites (Debian 30 tests, Alpine 32 tests)

## Alpine Notes

Alpine has **near-full security parity** with Debian. The shell shim works correctly on Alpine/BusyBox.

**Known issue (agentsh 0.16.4): Multicall binary bypass.** BusyBox and coreutils on Alpine are multicall binaries — `/bin/kill` → `/bin/busybox`, `/bin/rm` → `/bin/coreutils`. The v0.14.0+ path canonicalization resolves symlinks to the underlying multicall binary, then extracts `payload_command` from the *last argument* instead of argv[0]. This means `kill -9 1` gets `payload_command="1"` and `rm -rf /tmp/dir` gets `payload_command="dir"`, neither matching the block rules. The policy evaluator correctly denies these commands (verified by `agentsh debug policy-test`), but runtime seccomp enforcement doesn't block them. Alpine tests handle this with fallback policy-evaluation checks.

**bash_startup.sh on Alpine:** Alpine's bash has the `enable` builtin, but `enable -n enable` must be the LAST call because it disables itself. The Dockerfile.alpine writes a custom bash_startup.sh (overriding the release tarball's version) that also avoids disabling `command` and `builtin` which break shell scripts in the container.

**How the shim works on BusyBox (corrected 2026-02-19):** BusyBox uses `argv[0]` for applet detection, but `agentsh exec` runs `/bin/sh.real` with `argv[0]="sh.real"` — which BusyBox doesn't recognize ("applet not found"). The fix in `Dockerfile.alpine`: replace the BusyBox `/bin/sh` symlink with a link to bash *before* shim install (`rm -f /bin/sh && ln -s /bin/bash /bin/sh`). The installer then copies bash (not BusyBox) to `/bin/sh.real`. Bash ignores `argv[0]`, so it works correctly regardless of how it's invoked.

**Alpine-specific differences:**
- Binary path: `/usr/local/bin/agentsh` (tar.gz install), not `/usr/bin/agentsh` (.deb install)
- Shim install uses `--shim /usr/local/bin/agentsh-shell-shim` (not `/usr/bin/`)
- musl build is statically linked with libseccomp (`CGO_ENABLED=1 CGO_LDFLAGS="-static -lseccomp"`)
- Architecture: amd64 only (no arm64 musl build)
- `agentsh --version` shows "agentsh dev" (musl build doesn't embed version)
- Requires `fuse3` apk package for FUSE file I/O enforcement
- Requires `coreutils` apk for standalone binaries (reduces BusyBox multicall issues)
- Requires `util-linux-misc` apk (general utilities)
