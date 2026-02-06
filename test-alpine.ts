import 'dotenv/config'
import { execSync } from 'child_process'

// Blaxel sandbox test runner for Alpine variant
// Tests agentsh with musl libc on Alpine Linux
//
// NOTE: Alpine does NOT have the shell shim (BusyBox incompatibility).
// Policy enforcement relies on the agentsh HTTP API / session exec,
// not automatic shell interception. Output may appear in stdout or logs.

const SANDBOX_NAME = 'agentsh-blaxel-alpine'

interface ProcessResult {
  pid: string
  status: string
  exitCode: number
  stdout: string
  stderr: string
  logs: string
}

function getToken(): string {
  return execSync('bl token', { encoding: 'utf-8' }).trim()
}

function getSandboxUrl(): string {
  const output = execSync(`bl get sandbox ${SANDBOX_NAME} -o json`, { encoding: 'utf-8' })
  const data = JSON.parse(output)
  return data[0]?.metadata?.url
}

// Wait for sandbox to be ready (cold start can take ~60s)
async function waitForSandbox(sandboxUrl: string, token: string, maxWait = 90000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`${sandboxUrl}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ command: 'echo ready' })
      })
      if (res.ok) {
        const { pid } = await res.json() as { pid: string }
        for (let i = 0; i < 20; i++) {
          const status = await fetch(`${sandboxUrl}/process/${pid}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          const result = await status.json() as ProcessResult
          if (result.status === 'completed' || result.status === 'failed') return
          await new Promise(r => setTimeout(r, 500))
        }
        return
      }
    } catch {
      // Sandbox not ready yet
    }
    process.stdout.write('.')
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error('Sandbox did not become ready')
}

async function runCommand(sandboxUrl: string, token: string, command: string, timeout = 30000): Promise<ProcessResult> {
  const startRes = await fetch(`${sandboxUrl}/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ command })
  })

  if (!startRes.ok) {
    throw new Error(`Failed to start process: ${await startRes.text()}`)
  }

  const startData = await startRes.json() as { pid: string }
  const pid = startData.pid

  const startTime = Date.now()
  while (Date.now() - startTime < timeout) {
    const statusRes = await fetch(`${sandboxUrl}/process/${pid}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })

    const result = await statusRes.json() as ProcessResult

    if (result.status === 'completed' || result.status === 'failed') {
      return result
    }

    await new Promise(resolve => setTimeout(resolve, 500))
  }

  throw new Error(`Command timed out after ${timeout}ms`)
}

// Get output from a process result (sandbox may return in stdout or logs)
function getOutput(result: ProcessResult): string {
  return (result.stdout || result.logs || '').trim()
}

async function main() {
  console.log('='.repeat(60))
  console.log('AGENTSH-BLAXEL ALPINE TEST')
  console.log('='.repeat(60))

  const token = getToken()

  let sandboxUrl: string
  try {
    sandboxUrl = getSandboxUrl()
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
    sandboxUrl = getSandboxUrl()
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
      console.log(`✗ ERROR: ${err}`)
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
