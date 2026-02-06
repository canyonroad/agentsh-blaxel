import 'dotenv/config'
import { execSync } from 'child_process'

// Blaxel sandbox test runner
// Tests agentsh installation, server health, and shell shim
//
// Commands run through the sandbox API are intercepted by the
// agentsh shell shim — output may appear in stdout or logs.

const SANDBOX_NAME = 'agentsh-blaxel'

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

function getStderr(result: ProcessResult): string {
  return (result.stderr || result.logs || '').trim()
}

async function main() {
  console.log('='.repeat(60))
  console.log('AGENTSH-BLAXEL TEMPLATE TEST')
  console.log('='.repeat(60))

  const token = getToken()
  const sandboxUrl = getSandboxUrl()

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
      console.log(`✗ ERROR: ${err}`)
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

    await test('CGO/libseccomp support', async () => {
      const result = await runCommand(sandboxUrl, token, 'ldd /usr/bin/agentsh 2>&1 | grep -E "seccomp|not.*dynamic"')
      const output = getOutput(result)
      console.log(`\n    Binary linking: ${output}`)
      return output.includes('libseccomp')
    })

    // Test Suite 2: Server Health
    console.log('\n=== Test Suite: Server Health ===')

    await test('agentsh server healthy', async () => {
      const result = await runCommand(sandboxUrl, token, 'curl -s http://127.0.0.1:18080/health')
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
      await runCommand(sandboxUrl, token, 'mkdir -p /tmp/testdir && touch /tmp/testdir/f.txt')
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
      const result = await runCommand(sandboxUrl, token, 'curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.github.com/')
      return getOutput(result) === '200'
    })

    await test('metadata endpoint blocked', async () => {
      const result = await runCommand(sandboxUrl, token, 'curl -s --connect-timeout 3 http://169.254.169.254/ 2>&1')
      return result.exitCode !== 0 || getOutput(result) === ''
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
