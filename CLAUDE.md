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

## agentsh 0.20.2 Shell-Shim Posture (kernel-install path)

Starting in the 0.19.1 line, the shell shim installs kernel-level seccomp
enforcement (the `unixwrap` path) instead of routing every command through
`agentsh exec`. On Blaxel, `sandbox-api` always runs `/bin/sh -c "<command>"`
and we do **not** control the invocation shape. The 0.19.1–0.20.1 unixwrap path
had two gaps for this setup (filed as #374 and #378); both are fixed in
0.20.2 and this repo is configured to use the fixes:

1. **Opaque `sh -c` scripts run under per-exec enforcement** (`sandbox.seccomp.shellc.opaque: enforce`,
   the 0.20.2 default; pinned in `config.yaml`). Scripts the shim cannot
   statically resolve to a single command — pipes (`|`), redirects (`2>&1`, `>`),
   variable expansion (`$VAR`), substitution, `;`, `&&`, globs — run through the
   wrapped shell with `execve` interception, so **inner commands are still
   policy-checked** (a blocked binary inside the script is denied). On 0.20.1
   these all fail-closed as `shellc-opaque-script` (exit 126) with no knob.
   Values: `deny` | `enforce` | `allow`. The `opaque sh -c runs under per-exec
   enforcement` test in both suites verifies a safe pipe runs (exit 0) and a
   blocked inner command is still denied (exit 126). Resolved by
   [canyonroad/agentsh#378](https://github.com/canyonroad/agentsh/issues/378) (PR #386).

2. **`sandbox.env_inject` is applied on the unixwrap path again** (PR #380), so
   `BASH_ENV` (and the OTEL vars) reach executed commands via config `env_inject`.
   The 0.20.1 entrypoint `BASH_ENV` export workaround was **removed** — config
   `env_inject` is the mechanism again. Resolved by
   [canyonroad/agentsh#374](https://github.com/canyonroad/agentsh/issues/374) (PR #380).

`env_policy` (allow/deny) enforcement on the wrap path is **enabled** here via
`sandbox.wrap_env_policy.enabled: true` (PR #387 / #379). Without it the wrap
path leaked the full `sandbox-api` environment into commands (~40 vars incl.
`BL_*`, `NODE_VERSION`, `HOST`, `PORT`); with it, only the `default.yaml`
`env_policy` allow list passes (~20 vars: `AGENTSH_*`, `BASH_ENV`, `OTEL_*`,
`HOME`, `PATH`, `PWD`, `TERM`) and the deny list (`AWS_*`, `*_TOKEN`, `LD_*`, …)
is stripped — verified live (no `BL_*` leak; shim still works since `AGENTSH_*`
is allowlisted). `env_inject` values are operator-trusted and bypass this filter.

**Command-shell detail:** the shim's `/bin/sh` and `/bin/bash` are the shim
binary; `/bin/sh.real` is **dash** on Debian and **bash** on Alpine
(Dockerfile.alpine repoints `/bin/sh`→bash before shim install). Because dash
ignores `BASH_ENV` and has no `enable` builtin, `bash_startup.sh`'s
`enable -n kill` only hardens the bash path — the Debian `sh -c` (dash) builtin
`kill` is not disabled by it. External `/bin/kill` is still blocked (exit 126)
in both variants; only the in-shell builtin on the dash path is unaffected.

## Deploying and Testing

```bash
bl deploy                    # Deploy Debian variant
npx tsx demo-blocking.ts     # Policy enforcement demo
npx tsx test-debian.ts     # Full test suite (31/31 pass)
npx tsx test-alpine.ts       # Alpine test suite (33/33 pass, auto-deploys)
bl delete sandbox agentsh-blaxel  # Clean up
```

**Blaxel deploy:** `bl deploy` always reads `./blaxel.toml` and `./Dockerfile`. There is NO `-f` flag. To deploy the Alpine variant, swap both files (the test-alpine.ts script does this automatically). The `dockerfile` field in blaxel.toml is not supported — it is silently ignored.

**Cold start timing:** After `bl deploy`, the sandbox needs ~60 seconds before commands work. A 30-second wait is not enough — the pod takes time to provision and the Blaxel service needs to register. If commands fail with "No healthy pods available" / 404, wait longer and retry. Once the first command succeeds, subsequent commands are fast.

## Current Blaxel Protection Posture

- `agentsh detect` reports `Security Mode: minimal` and `Protection Score: 50/100` on both Debian and Alpine Blaxel sandboxes
- AST currently scores `15/28 (54%)`
- The main runtime gaps are: no `cgroups v2`, no `eBPF`, no PID namespace isolation, and no effective capability drop
- There is no general ptrace + seccomp hybrid for extra networking protection in agentsh `0.20.2`; ptrace is a separate fallback mode, not an additive network layer

**What Blaxel would need to add for stronger agentsh protection:**
- `cgroups v2`
- `seccomp user-notify`
- `eBPF` support plus required capabilities
- PID namespace isolation
- Capability dropping / least-privilege defaults
- Kernel `6.7+` / Landlock ABI v4 for TCP restrictions
- Non-root workload execution and tighter `/proc` / system-file exposure
- Raw socket blocking unless explicitly required
- Consistent routing through the agentsh proxy with declared `http_services`

## Version History

- **0.20.2** (current) - Final release that fixes the two issues this repo filed against the 0.19.1+ kernel-install shim path. PR #380 (#374): `sandbox.env_inject` is applied again on the wrap-init/unixwrap path — so the entrypoint `BASH_ENV` export workaround was removed and config `env_inject` is the mechanism again. PR #386 (#378): new **`sandbox.seccomp.shellc.opaque`** knob (`deny`|`enforce`|`allow`); **default is now `enforce`**, so opaque `sh -c` scripts (pipes/redirects/`&&`/`$`-expansion/globs) run through the wrapped shell with per-exec interception instead of fail-closing. Also: PR #387 (#379) adds `env_policy` enforcement on the wrap path (**enabled here** via `sandbox.wrap_env_policy.enabled`), PR #384 allows `command -v/-V` introspection in the shell-c pre-check, PR #381 makes opaque pre-deny interception-aware, PR #385 stops blanket-denying commands from a symlinked cwd under `symlink_escape=deny`. Adds over rc1: PR #389/#392 improve seccomp capability detection (real NEW_LISTENER install probe + honest `detect`/SelectMode reporting) — no change to the Blaxel result (still `minimal`, AST 15/28).
- **0.20.1** - Small maintenance release. FUSE symlink policy fix (#313: symlink leaf ops checked on the link, fixes Python-venv breakage), live `PolicyPush` from watchtower with signature/hash verification, `require_where` DB policy guard. **Breaking/operator-visible:** (1) `policies.symlink_escape` now defaults to `evaluate` (outside-root symlinks are evaluated against `file_rules` instead of an unconditional deny) — set `policies.symlink_escape: deny` to restore the prior hardened posture. (2) `audit.watchtower.agent_id` fallback now emits `<hostname>-<pid>` instead of bare hostname (not used in this repo — no watchtower config).
- **0.20.0** - Full PostgreSQL access proxy (wire-level interception, classification, policy evaluation, redirect runtime). Sandboxing/wrap fixes for hosted runtimes (Vercel/Daytona/Firecracker), eBPF attach-only cgroup mode, FUSE correctness fixes. Fixed an rc1 regression (#361) where the shim engaged the wrapper despite `unix_sockets.enabled: false`.
- **0.19.3** - Security mitigation for the "Dirty Frag" advisory: protocol-aware socket tuple rules and YAML mitigation sets. **Breaking:** `sandbox.seccomp.hardening_profiles` was removed; configs using it now fail with a migration message (this repo never used it — no impact).
- **0.19.1** - Shim-installed kernel enforcement (#274: the shell shim installs the seccomp wrapper at the kernel layer, closing the SDK-driven-exec bypass; modes `auto`/`on`/`off`), shim wrap-init policy pre-check (#279), `argv[0]` preservation for busybox-multicall systems / Alpine (#280), `.real` suffix stripping in policy matching (#278), `unixwrap` PATH fallback (#277), cgroup writability probe before claiming nested mode.
- **0.19.0** - Socket family blocking (#261: per-`AF_*` blocking on socket/socketpair via seccomp-bpf with ptrace fallback; default 12 families return `EAFNOSUPPORT`; both engines emit identical audit events). Experimental skillcheck (#259/#260) for scanning AI agent skill installations.
- **0.18.3** - agentsh patch release; previous version for this repo.
- **0.18.0** - External secrets + unified `http_services`, audit HMAC-chain tamper evidence, seccomp/ptrace/cgroup/Landlock fixes, and musl arm64 release assets. This repo now installs the shell shim with `--force` so `/etc/agentsh/shim.conf` persists non-interactive enforcement, while the entrypoint still pre-creates a session for sandbox-api.
- **0.16.9** - Improved seccomp file_monitor: properly blocks openat(O_WRONLY) on protected files, /proc/mem fallback for path resolution, LD_PRELOAD ptracer for child processes under Yama. Known issues: (1) `intercept_metadata: true` breaks shell shim by blocking stat on `/bin/sh.real` during exec.LookPath -- must use `intercept_metadata: false`. (2) Session instability under rapid sequential commands (PR_SET_PTRACER fails under Yama, ProcessVMReadv fallback may deadlock after several exec calls). AST score: 18/28 (64%) with L5:4 structural credential isolation.
- **0.16.8** - Stability and cross-platform fixes. Adds `/etc/agentsh/shim.conf` for enforcing policies in non-interactive environments (alternative to `AGENTSH_SHIM_FORCE`). Fixed argv0 handling for BusyBox/Alpine, removed all `syscall.Exec` from shim (uses piping), fixed daemon fd leak in sandbox toolboxes, fixed ptrace/seccomp deadlocks in hybrid mode. Stricter file I/O enforcement blocks `ldd` from reading binary files (test updated to use `ldconfig`). Multicall binary bypass on Alpine persists.
- **0.16.7** - Hybrid ptrace-execve + seccomp wrapper mode for restricted environments. Async SQLite batching. Fixed notify handler goroutine leak (sessions unstable after ~10-15 exec calls). Fixed ptrace prefilter TSYNC for consistent thread filtering.
- **0.16.6** - Previous stable. Both Dockerfiles install `agentsh-stub` binary for exec redirect.
- **0.16.4** - Ed25519 policy signing, ptrace enforcement backend, seccomp file monitor, path canonicalization for execve. Known issue: BusyBox/coreutils multicall binary unwrapping extracts wrong `payload_command` (last arg instead of argv[0]), causing kill/rm bypass on Alpine. Policy evaluation is correct; runtime enforcement fails for multicall binaries.
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
- `debian/entrypoint.sh` — Uses `#!/bin/bash.real` (not `/bin/bash`) because bash IS the shim. Pre-creates a session for sandbox-api; the shim itself is installed with `--force`.
- `alpine/entrypoint.sh` — Uses `#!/bin/bash.real` (same as Debian). Pre-creates a session for sandbox-api; the shim itself is installed with `--force`.
- `sandbox-utils.ts` — Shared sandbox API utilities (command exec, deploy helpers)
- `demo-blocking.ts` — Runs commands directly through sandbox API, checks exit codes, queries events for rule names
- `test-debian.ts` / `test-alpine.ts` — Full test suites (Debian 31 tests, Alpine 33 tests)

## Alpine Notes

Alpine has **near-full security parity** with Debian. The shell shim works correctly on Alpine/BusyBox.

**Known issue (persists through 0.16.8): Multicall binary bypass.** BusyBox and coreutils on Alpine are multicall binaries — `/bin/kill` → `/bin/busybox`, `/bin/rm` → `/bin/coreutils`. The path canonicalization resolves symlinks to the underlying multicall binary, then extracts `payload_command` from the *last argument* instead of argv[0]. This means `kill -9 1` gets `payload_command="1"` and `rm -rf /tmp/dir` gets `payload_command="dir"`, neither matching the block rules. The policy evaluator correctly denies these commands (verified by `agentsh debug policy-test`), but runtime seccomp enforcement doesn't block them. Alpine tests handle this with fallback policy-evaluation checks.

**bash_startup.sh on Alpine:** Alpine's bash has the `enable` builtin, but `enable -n enable` must be the LAST call because it disables itself. The Dockerfile.alpine writes a custom bash_startup.sh (overriding the release tarball's version) that also avoids disabling `command` and `builtin` which break shell scripts in the container.

**How the shim works on BusyBox (corrected 2026-02-19):** BusyBox uses `argv[0]` for applet detection, but `agentsh exec` runs `/bin/sh.real` with `argv[0]="sh.real"` — which BusyBox doesn't recognize ("applet not found"). The fix in `Dockerfile.alpine`: replace the BusyBox `/bin/sh` symlink with a link to bash *before* shim install (`rm -f /bin/sh && ln -s /bin/bash /bin/sh`). The installer then copies bash (not BusyBox) to `/bin/sh.real`. Bash ignores `argv[0]`, so it works correctly regardless of how it's invoked.

**Alpine-specific differences:**
- Binary path: `/usr/local/bin/agentsh` (tar.gz install), not `/usr/bin/agentsh` (.deb install)
- Shim install uses `--shim /usr/local/bin/agentsh-shell-shim` (not `/usr/bin/`)
- musl build is statically linked with libseccomp (`CGO_ENABLED=1 CGO_LDFLAGS="-static -lseccomp"`)
- Architecture: amd64 and arm64 musl builds are available in 0.20.2
- `agentsh --version` shows "agentsh dev" (musl build doesn't embed version)
- Requires `fuse3` apk package for FUSE file I/O enforcement
- Requires `coreutils` apk for standalone binaries (reduces BusyBox multicall issues)
- Requires `util-linux-misc` apk (general utilities)
