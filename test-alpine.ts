import 'dotenv/config'
import { execSync } from 'child_process'

// Blaxel sandbox test runner for Alpine variant
// Tests agentsh with musl libc on Alpine Linux

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
    // Test 1: Check Alpine/musl
    console.log('\n=== Test Suite: Alpine Environment ===')

    await test('Check Alpine Linux', async () => {
      const result = await runCommand(sandboxUrl, token, 'cat /etc/os-release | grep -i alpine')
      return result.stdout.toLowerCase().includes('alpine')
    })

    await test('Check musl libc', async () => {
      const result = await runCommand(sandboxUrl, token, 'ldd --version 2>&1 | head -1')
      return result.stdout.includes('musl') || result.stderr.includes('musl')
    })

    // Test 2: agentsh installation
    console.log('\n=== Test Suite: agentsh Installation ===')

    await test('agentsh binary exists', async () => {
      const result = await runCommand(sandboxUrl, token, 'which agentsh')
      return result.exitCode === 0
    })

    await test('agentsh version', async () => {
      const result = await runCommand(sandboxUrl, token, 'agentsh --version')
      console.log(`\n    Version: ${result.stdout.trim()}`)
      return result.exitCode === 0
    })

    await test('agentsh-shell-shim exists', async () => {
      const result = await runCommand(sandboxUrl, token, 'which agentsh-shell-shim')
      return result.exitCode === 0
    })

    await test('agentsh-unixwrap exists', async () => {
      const result = await runCommand(sandboxUrl, token, 'which agentsh-unixwrap')
      return result.exitCode === 0
    })

    // Test 3: Server health
    console.log('\n=== Test Suite: Server Health ===')

    await test('agentsh server health', async () => {
      const result = await runCommand(sandboxUrl, token, 'curl -s http://127.0.0.1:18080/health')
      return result.stdout.trim() === 'ok'
    })

    // Test 4: Security features
    console.log('\n=== Test Suite: Security Features ===')

    await test('sudo is blocked', async () => {
      const result = await runCommand(sandboxUrl, token, 'sudo echo test 2>&1')
      return result.exitCode !== 0
    })

    await test('kill builtin is disabled (BASH_ENV)', async () => {
      const result = await runCommand(sandboxUrl, token, '/bin/bash -c "kill -9 1 2>&1; echo exit=$?"')
      return result.stdout.includes('exit=127') || result.stdout.includes('not found')
    })

    await test('nc is blocked', async () => {
      const result = await runCommand(sandboxUrl, token, 'nc -h 2>&1')
      return result.exitCode !== 0
    })

    await test('curl to allowed domain works', async () => {
      const result = await runCommand(sandboxUrl, token, 'curl -s --connect-timeout 5 https://api.github.com/ | head -1')
      return result.exitCode === 0
    })

    await test('metadata endpoint blocked', async () => {
      const result = await runCommand(sandboxUrl, token, 'curl -s --connect-timeout 3 http://169.254.169.254/ 2>&1')
      return result.exitCode !== 0 || result.stdout.includes('timeout') || result.stdout === ''
    })

    // Test 5: Command execution
    console.log('\n=== Test Suite: Command Execution ===')

    await test('echo command works', async () => {
      const result = await runCommand(sandboxUrl, token, 'echo "Hello from Alpine!"')
      return result.stdout.includes('Hello from Alpine')
    })

    await test('bash -c works', async () => {
      const result = await runCommand(sandboxUrl, token, '/bin/bash -c "echo test"')
      return result.stdout.includes('test')
    })

    await test('env shows BASH_ENV', async () => {
      const result = await runCommand(sandboxUrl, token, 'env | grep BASH_ENV')
      return result.stdout.includes('/usr/lib/agentsh/bash_startup.sh')
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
