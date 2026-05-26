import 'dotenv/config'
import { getToken, getSandboxUrl, waitForSandbox, runCommand, getOutput } from './sandbox-utils.js'

// Blaxel sandbox test runner
// Tests agentsh installation, server health, and shell shim
//
// Commands run through the sandbox API are intercepted by the
// agentsh shell shim — output may appear in stdout or logs.

const SANDBOX_NAME = 'agentsh-blaxel'

async function main() {
  console.log('='.repeat(60))
  console.log('AGENTSH-BLAXEL DEBIAN TEST')
  console.log('='.repeat(60))

  const token = getToken()
  const sandboxUrl = getSandboxUrl(SANDBOX_NAME)

  if (!sandboxUrl) {
    console.error('Sandbox not found. Run: bl deploy')
    process.exit(1)
  }

  console.log(`\nSandbox URL: ${sandboxUrl}`)

  // Wait for sandbox cold start
  process.stdout.write('Waiting for sandbox to be ready...')
  await waitForSandbox(sandboxUrl, token)
  console.log(' ready!\n')

  let passed = 0
  let failed = 0

  const test = async (name: string, fn: () => Promise<boolean>) => {
    process.stdout.write(`  ${name}... `)
    try {
      const result = await fn()
      if (result) {
        console.log('✓ PASS')
        passed++
      } else {
        console.log('✗ FAIL')
        failed++
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`✗ ERROR: ${message}`)
      failed++
    }
  }

  try {
    // Test Suite 1: Installation
    console.log('\n=== Test Suite: agentsh Installation ===')

    await test('agentsh installed', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh --version 2>&1')
      const output = getOutput(result)
      console.log(`\n    Version: ${output}`)
      return result.exitCode === 0 && output.includes('agentsh')
    })

    await test('libseccomp2 installed', async () => {
      const result = await runCommand(sandboxUrl, token, 'ldconfig -p')
      const output = getOutput(result)
      console.log(`\n    Library: ${output}`)
      return output.includes('libseccomp')
    })

    // Test Suite 2: Server Health
    console.log('\n=== Test Suite: Server Health ===')

    await test('agentsh server healthy', async () => {
      const result = await runCommand(sandboxUrl, token, "curl -s 'http://127.0.0.1:18080/health'")
      return getOutput(result) === 'ok'
    })

    // Test Suite 3: Configuration
    console.log('\n=== Test Suite: Configuration ===')

    await test('policy file exists', async () => {
      const result = await runCommand(sandboxUrl, token, 'head -5 /etc/agentsh/policies/default.yaml')
      return result.exitCode === 0 && getOutput(result).includes('version')
    })

    await test('config file exists', async () => {
      const result = await runCommand(sandboxUrl, token, 'head -5 /etc/agentsh/config.yaml')
      return result.exitCode === 0 && getOutput(result).includes('security')
    })

    // Test Suite 4: Shell Shim
    console.log('\n=== Test Suite: Shell Shim ===')

    await test('echo through shim', async () => {
      const result = await runCommand(sandboxUrl, token, 'echo "Hello from agentsh-blaxel!"')
      return result.exitCode === 0 && getOutput(result).includes('Hello')
    })

    await test('file listing through shim', async () => {
      const result = await runCommand(sandboxUrl, token, 'ls /etc/agentsh/')
      return result.exitCode === 0
    })

    await test('bash execution through shim', async () => {
      const result = await runCommand(sandboxUrl, token, '/bin/bash -c "echo bash-ok"')
      return result.exitCode === 0 && getOutput(result).includes('bash-ok')
    })

    await test('opaque sh -c runs under per-exec enforcement (shellc.opaque=enforce)', async () => {
      // agentsh 0.20.2 (#378): opaque sh -c scripts (pipes, redirects, &&,
      // $-expansion, globs) now run through the wrapped shell WITH per-exec
      // interception instead of being denied (0.20.1 fail-closed them as
      // shellc-opaque-script). Safe scripts run; inner blocked commands are
      // still enforced.
      const safe = await runCommand(sandboxUrl, token, 'echo opaque | cat')
      if (safe.exitCode !== 0 || !getOutput(safe).includes('opaque')) return false
      // a blocked command inside an opaque script is still denied (sudo placed
      // last so its non-zero exit propagates)
      const blocked = await runCommand(sandboxUrl, token, 'true && /usr/bin/sudo whoami')
      console.log(`\n    safe pipe exit=${safe.exitCode}; blocked-in-script exit=${blocked.exitCode}`)
      return blocked.exitCode === 126
    })

    // Test Suite 5: Policy Enforcement
    console.log('\n=== Test Suite: Policy Enforcement ===')

    await test('sudo blocked (exit 126)', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/sudo whoami')
      return result.exitCode === 126
    })

    await test('ssh blocked (exit 126)', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/ssh localhost')
      return result.exitCode === 126
    })

    await test('kill blocked (exit 126)', async () => {
      const result = await runCommand(sandboxUrl, token, '/bin/kill -9 1')
      return result.exitCode === 126
    })

    await test('rm -rf blocked (exit 126)', async () => {
      await runCommand(sandboxUrl, token, 'mkdir -p /tmp/testdir')
      await runCommand(sandboxUrl, token, 'touch /tmp/testdir/f.txt')
      const result = await runCommand(sandboxUrl, token, '/bin/rm -rf /tmp/testdir')
      return result.exitCode === 126
    })

    await test('echo allowed (exit 0)', async () => {
      const result = await runCommand(sandboxUrl, token, '/bin/echo policy-test')
      return result.exitCode === 0 && getOutput(result).includes('policy-test')
    })

    // Test Suite 6: Network Policy
    console.log('\n=== Test Suite: Network Policy ===')

    await test('allowed domain (github.com)', async () => {
      const result = await runCommand(sandboxUrl, token, "curl -s --connect-timeout 5 -o /dev/null -w '%{http_code}' 'https://api.github.com/'")
      return getOutput(result) === '200'
    })

    await test('metadata endpoint blocked', async () => {
      const result = await runCommand(sandboxUrl, token, "curl -s --connect-timeout 3 'http://169.254.169.254/'")
      return result.exitCode !== 0 || getOutput(result) === ''
    })

    // Test Suite 7: Environment Policy
    console.log('\n=== Test Suite: Environment Policy ===')

    await test('env filtered to safe vars only', async () => {
      const result = await runCommand(sandboxUrl, token, 'env')
      const output = getOutput(result)
      const lines = output.split('\n')
      // Should NOT contain any cloud credentials or API keys
      const blocked = ['AWS_', 'AZURE_', 'GOOGLE_', 'OPENAI_', 'ANTHROPIC_', 'LD_LIBRARY_PATH']
      for (const prefix of blocked) {
        if (lines.some(line => line.startsWith(prefix))) return false
      }
      // LD_PRELOAD is OK when it's the agentsh ptracer (0.16.9+ injects this for Yama child tracking)
      const ldPreload = output.match(/LD_PRELOAD=(.*)/)?.[1] ?? ''
      if (ldPreload && !ldPreload.includes('agentsh')) return false
      // wrap_env_policy (0.20.2, PR #387) enforces the env_policy allowlist
      // on wrapped commands: Blaxel's non-allowlisted BL_* metadata must be
      // stripped (without enforcement these leak through).
      const blKeys = lines.filter(l => l.startsWith('BL_')).map(l => l.split('=')[0])
      console.log(`\n    env keys=${lines.filter(Boolean).length}; leaked BL_*=${blKeys.length ? blKeys.join(',') : 'none'}`)
      if (blKeys.length > 0) return false
      // Should contain basic safe vars
      return output.includes('HOME=') && output.includes('PATH=')
    })

    await test('BASH_ENV passed through', async () => {
      const result = await runCommand(sandboxUrl, token, 'env', 60000)
      return getOutput(result).split('\n').includes('BASH_ENV=/usr/lib/agentsh/bash_startup.sh')
    })

    await test('policy-test: sudo denied', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh debug policy-test --op exec --path sudo --json 2>&1')
      const output = getOutput(result)
      return output.includes('"deny"') && output.includes('block-shell-escape')
    })

    await test('policy-test: echo allowed', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh debug policy-test --op exec --path echo --json 2>&1')
      const output = getOutput(result)
      return output.includes('"allow"') && output.includes('allow-safe-commands')
    })

    // Test Suite 8: File I/O Policy (FUSE/landlock)
    console.log('\n=== Test Suite: File I/O Policy ===')

    // Policy evaluation tests — verify file_rules are loaded and evaluate correctly
    await test('policy-test: workspace write allowed', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh debug policy-test --op write --path /app/test.txt --json 2>&1')
      const output = getOutput(result)
      return output.includes('"allow"') && output.includes('allow-workspace-write')
    })

    await test('policy-test: workspace read allowed', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh debug policy-test --op read --path /app/test.txt --json 2>&1')
      const output = getOutput(result)
      return output.includes('"allow"') && output.includes('allow-workspace-read')
    })

    await test('policy-test: tmp write allowed', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh debug policy-test --op write --path /tmp/test.txt --json 2>&1')
      const output = getOutput(result)
      return output.includes('"allow"') && output.includes('allow-tmp')
    })

    await test('policy-test: workspace delete is soft-delete', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh debug policy-test --op delete --path /app/test.txt --json 2>&1')
      const output = getOutput(result)
      return output.includes('soft-delete-workspace')
    })

    await test('policy-test: SSH key access denied', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh debug policy-test --op read --path /root/.ssh/id_rsa --json 2>&1')
      const output = getOutput(result)
      return output.includes('"deny"') && output.includes('block-ssh-keys')
    })

    await test('policy-test: AWS credentials denied', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh debug policy-test --op read --path /root/.aws/credentials --json 2>&1')
      const output = getOutput(result)
      return output.includes('"deny"') && output.includes('block-aws-credentials')
    })

    await test('policy-test: system path write denied', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh debug policy-test --op write --path /usr/bin/testfile --json 2>&1')
      const output = getOutput(result)
      return output.includes('"deny"') && output.includes('block-system-path-writes')
    })

    await test('policy-test: /etc write denied', async () => {
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh debug policy-test --op write --path /etc/test.txt --json 2>&1')
      const output = getOutput(result)
      return output.includes('"deny"') && output.includes('block-system-path-writes')
    })

    // Actual file I/O enforcement tests — verify FUSE/landlock enforces file_rules
    await test('write to /app succeeds', async () => {
      const writeResult = await runCommand(sandboxUrl, token, 'node -e \'require("fs").writeFileSync("/app/fileio-test.txt","fileio-test")\'')
      if (writeResult.exitCode !== 0) return false
      const readResult = await runCommand(sandboxUrl, token, 'cat /app/fileio-test.txt')
      return readResult.exitCode === 0 && getOutput(readResult).includes('fileio-test')
    })

    await test('write to /tmp succeeds', async () => {
      const writeResult = await runCommand(sandboxUrl, token, 'node -e \'require("fs").writeFileSync("/tmp/fileio-test.txt","tmp-test")\'')
      if (writeResult.exitCode !== 0) return false
      const readResult = await runCommand(sandboxUrl, token, 'cat /tmp/fileio-test.txt')
      return readResult.exitCode === 0 && getOutput(readResult).includes('tmp-test')
    })

    await test('read system files succeeds', async () => {
      const result = await runCommand(sandboxUrl, token, 'cat /etc/hostname')
      return result.exitCode === 0 && getOutput(result).length > 0
    })

    // Summary
    console.log('\n' + '='.repeat(60))
    console.log(`RESULTS: ${passed} passed, ${failed} failed`)
    console.log('='.repeat(60))

    process.exit(failed > 0 ? 1 : 0)

  } catch (error) {
    console.error('Test failed:', error)
    process.exit(1)
  }
}

main().catch(console.error)
