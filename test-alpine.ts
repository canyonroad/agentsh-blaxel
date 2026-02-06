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
    execSync('bl deploy -f blaxel-alpine.toml', { stdio: 'inherit' })
    console.log('Waiting for sandbox to be ready...')
    await new Promise(resolve => setTimeout(resolve, 30000))
    sandboxUrl = getSandboxUrl()
  }

  if (!sandboxUrl) {
    console.error('Sandbox not found. Run: bl deploy -f blaxel-alpine.toml')
    process.exit(1)
  }

  console.log(`\nSandbox URL: ${sandboxUrl}\n`)

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
      const result = await runCommand(sandboxUrl, token, '/usr/bin/agentsh --version 2>&1')
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
    // Note: Alpine has NO shell shim, so commands bypass agentsh policy
    // when run through the sandbox-api. These tests verify what works
    // without the shim (BASH_ENV blocking, network policy).
    console.log('\n=== Test Suite: Security Features ===')

    await test('sudo blocked', async () => {
      const result = await runCommand(sandboxUrl, token, 'sudo echo test 2>&1')
      return result.exitCode !== 0
    })

    await test('kill builtin disabled (BASH_ENV)', async () => {
      const result = await runCommand(sandboxUrl, token, '/bin/bash -c "kill -9 1 2>&1; echo exit=$?"')
      const output = getOutput(result)
      return output.includes('exit=127') || output.includes('not found')
    })

    await test('nc blocked', async () => {
      const result = await runCommand(sandboxUrl, token, 'nc -h 2>&1')
      return result.exitCode !== 0
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
