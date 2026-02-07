import 'dotenv/config'
import { execSync } from 'child_process'
import { getToken, getSandboxUrl, waitForSandbox, runCommand, getOutput } from './sandbox-utils.js'

// Blaxel sandbox test runner for Alpine variant
// Tests agentsh with musl libc on Alpine Linux
//
// NOTE: Alpine does NOT have the shell shim (BusyBox incompatibility).
// Policy enforcement relies on the agentsh HTTP API / session exec,
// not automatic shell interception. Output may appear in stdout or logs.

const SANDBOX_NAME = 'agentsh-blaxel-alpine'

async function main() {
  console.log('='.repeat(60))
  console.log('AGENTSH-BLAXEL ALPINE TEST')
  console.log('='.repeat(60))

  const token = getToken()

  let sandboxUrl: string
  try {
    sandboxUrl = getSandboxUrl(SANDBOX_NAME)
  } catch {
    console.log('\nAlpine sandbox not deployed. Deploying now...')
    // bl deploy always uses ./blaxel.toml and ./Dockerfile — swap both
    execSync('cp blaxel.toml blaxel.toml.bak && cp blaxel-alpine.toml blaxel.toml', { stdio: 'inherit' })
    execSync('cp Dockerfile Dockerfile.bak && cp Dockerfile.alpine Dockerfile', { stdio: 'inherit' })
    try {
      execSync('bl deploy --yes', { stdio: 'inherit' })
    } finally {
      execSync('mv blaxel.toml.bak blaxel.toml', { stdio: 'inherit' })
      execSync('mv Dockerfile.bak Dockerfile', { stdio: 'inherit' })
    }
    console.log('Waiting for sandbox to be ready...')
    await new Promise(resolve => setTimeout(resolve, 30000))
    sandboxUrl = getSandboxUrl(SANDBOX_NAME)
  }

  if (!sandboxUrl) {
    console.error('Sandbox not found. Deploy with: npx tsx test-alpine.ts (auto-deploys)')
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
    // Test Suite 1: Alpine Environment
    console.log('\n=== Test Suite: Alpine Environment ===')

    await test('Alpine Linux detected', async () => {
      const result = await runCommand(sandboxUrl, token, 'cat /etc/os-release | grep -i alpine')
      return getOutput(result).toLowerCase().includes('alpine')
    })

    await test('musl libc detected', async () => {
      const result = await runCommand(sandboxUrl, token, 'ldd --version 2>&1 | head -1')
      const output = getOutput(result)
      const stderr = (result.stderr || result.logs || '').trim()
      return output.includes('musl') || stderr.includes('musl')
    })

    // Test Suite 2: agentsh Installation
    console.log('\n=== Test Suite: agentsh Installation ===')

    await test('agentsh binary exists', async () => {
      const result = await runCommand(sandboxUrl, token, 'which agentsh')
      return result.exitCode === 0
    })

    await test('agentsh version', async () => {
      const result = await runCommand(sandboxUrl, token, 'agentsh --version 2>&1')
      const output = getOutput(result)
      console.log(`\n    Version: ${output}`)
      return result.exitCode === 0 && output.includes('agentsh')
    })

    await test('agentsh-shell-shim exists', async () => {
      const result = await runCommand(sandboxUrl, token, 'which agentsh-shell-shim')
      return result.exitCode === 0
    })

    await test('agentsh-unixwrap exists', async () => {
      const result = await runCommand(sandboxUrl, token, 'which agentsh-unixwrap')
      return result.exitCode === 0
    })

    // Test Suite 3: Server Health
    console.log('\n=== Test Suite: Server Health ===')

    await test('agentsh server healthy', async () => {
      const result = await runCommand(sandboxUrl, token, 'curl -s http://127.0.0.1:18080/health')
      return getOutput(result) === 'ok'
    })

    // Test Suite 4: Security Features
    // Note: Alpine has NO shell shim, so commands bypass agentsh seccomp policy
    // when run through the sandbox-api. These tests verify what works
    // without the shim: BASH_ENV builtin disabling and network policy.
    console.log('\n=== Test Suite: Security Features (no shell shim) ===')

    await test('kill builtin disabled via BASH_ENV', async () => {
      // BASH_ENV disables bash builtins; kill falls back to /bin/kill
      const result = await runCommand(sandboxUrl, token, '/bin/bash -c "type kill 2>&1"')
      const output = getOutput(result)
      // Should show "/bin/kill" (not "kill is a shell builtin")
      return output.includes('/bin/kill')
    })

    await test('allowed domain (github.com)', async () => {
      const result = await runCommand(sandboxUrl, token, 'curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.github.com/')
      return getOutput(result) === '200'
    })

    await test('metadata endpoint blocked', async () => {
      const result = await runCommand(sandboxUrl, token, 'curl -s --connect-timeout 3 http://169.254.169.254/ 2>&1')
      return result.exitCode !== 0 || getOutput(result) === ''
    })

    // Test Suite 5: Command Execution
    console.log('\n=== Test Suite: Command Execution ===')

    await test('echo command works', async () => {
      const result = await runCommand(sandboxUrl, token, 'echo "Hello from Alpine!"')
      return getOutput(result).includes('Hello from Alpine')
    })

    await test('bash -c works', async () => {
      const result = await runCommand(sandboxUrl, token, '/bin/bash -c "echo bash-ok"')
      return getOutput(result).includes('bash-ok')
    })

    await test('BASH_ENV is set', async () => {
      const result = await runCommand(sandboxUrl, token, 'env | grep BASH_ENV')
      return getOutput(result).includes('/usr/lib/agentsh/bash_startup.sh')
    })

    // Test Suite 6: Environment Policy
    console.log('\n=== Test Suite: Environment Policy ===')

    await test('env filtered to safe vars only', async () => {
      const result = await runCommand(sandboxUrl, token, 'env | sort')
      const output = getOutput(result)
      const blocked = ['AWS_', 'AZURE_', 'GOOGLE_', 'OPENAI_', 'ANTHROPIC_', 'LD_PRELOAD', 'LD_LIBRARY_PATH']
      for (const prefix of blocked) {
        if (output.includes(prefix)) return false
      }
      return output.includes('HOME=') && output.includes('PATH=')
    })

    await test('policy-test: sudo denied', async () => {
      const result = await runCommand(sandboxUrl, token, 'agentsh debug policy-test --op exec --path sudo --json 2>&1')
      const output = getOutput(result)
      return output.includes('"deny"') && output.includes('block-shell-escape')
    })

    await test('policy-test: echo allowed', async () => {
      const result = await runCommand(sandboxUrl, token, 'agentsh debug policy-test --op exec --path echo --json 2>&1')
      const output = getOutput(result)
      return output.includes('"allow"') && output.includes('allow-safe-commands')
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
