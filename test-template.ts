import 'dotenv/config'
import { execSync } from 'child_process'

// Blaxel sandbox test runner
// Uses REST API to interact with sandbox

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

async function runCommand(sandboxUrl: string, token: string, command: string, timeout = 30000): Promise<ProcessResult> {
  // Start the process
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

  // Poll for completion
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
  console.log('AGENTSH-BLAXEL TEMPLATE TEST')
  console.log('='.repeat(60))

  const token = getToken()
  const sandboxUrl = getSandboxUrl()

  if (!sandboxUrl) {
    console.error('Sandbox not found. Run: bl deploy')
    process.exit(1)
  }

  console.log(`\nSandbox URL: ${sandboxUrl}\n`)

  try {
    // Test 1: Check agentsh installation
    console.log('=== Test 1: Check agentsh installation ===')
    const versionResult = await runCommand(sandboxUrl, token, 'agentsh --version')
    console.log(`agentsh version: ${versionResult.stdout.trim()}`)
    console.log('✓ agentsh installed\n')

    // Test 2: Check CGO/libseccomp support
    console.log('=== Test 2: Check CGO/libseccomp support ===')
    const lddResult = await runCommand(sandboxUrl, token, 'ldd /usr/bin/agentsh | grep -E "seccomp|not.*dynamic"')
    console.log(`Binary linking: ${lddResult.stdout.trim()}`)
    if (lddResult.stdout.includes('libseccomp')) {
      console.log('✓ CGO/libseccomp support enabled\n')
    } else {
      console.log('✗ WARNING: No libseccomp support - seccomp features disabled\n')
    }

    // Test 3: Check agentsh server health
    console.log('=== Test 3: Check agentsh server ===')
    const healthResult = await runCommand(sandboxUrl, token, 'curl -s http://127.0.0.1:19080/health')
    console.log(`Server health: ${healthResult.stdout.trim()}`)
    if (healthResult.stdout.trim() === 'ok') {
      console.log('✓ Server is healthy\n')
    } else {
      console.log('✗ Server not responding\n')
    }

    // Test 4: Check policy configuration
    console.log('=== Test 4: Check policy configuration ===')
    const policyResult = await runCommand(sandboxUrl, token, 'head -15 /etc/agentsh/policies/default.yaml')
    console.log(`Policy:\n${policyResult.stdout}`)
    console.log('✓ Policy file exists\n')

    // Test 5: Check server configuration
    console.log('=== Test 5: Check server configuration ===')
    const configResult = await runCommand(sandboxUrl, token, 'head -15 /etc/agentsh/config.yaml')
    console.log(`Config:\n${configResult.stdout}`)
    console.log('✓ Config file exists\n')

    // Test 6: Test command execution via agentsh exec
    console.log('=== Test 6: Test agentsh exec ===')
    const execResult = await runCommand(sandboxUrl, token,
      'agentsh exec test-session --timeout 10s -- /bin/echo "Hello from agentsh-blaxel!"')
    console.log(`Exec output: ${execResult.stdout.trim()}`)
    if (execResult.exitCode === 0 && execResult.stdout.includes('Hello')) {
      console.log('✓ agentsh exec works\n')
    } else {
      console.log('✗ agentsh exec failed\n')
    }

    // Test 7: Test another command via agentsh exec
    console.log('=== Test 7: Test file listing via agentsh exec ===')
    const lsResult = await runCommand(sandboxUrl, token,
      'agentsh exec test-session --timeout 10s -- /bin/ls -la /etc/agentsh/')
    console.log(`ls output:\n${lsResult.stdout}`)
    if (lsResult.exitCode === 0) {
      console.log('✓ File listing works\n')
    } else {
      console.log('✗ File listing failed\n')
    }

    // Test 8: Test bash command via agentsh exec
    console.log('=== Test 8: Test bash via agentsh exec ===')
    const bashResult = await runCommand(sandboxUrl, token,
      'agentsh exec test-session --timeout 10s -- /bin/bash -c "echo Current time: $(date)"')
    console.log(`Bash output: ${bashResult.stdout.trim()}`)
    if (bashResult.exitCode === 0) {
      console.log('✓ Bash execution works\n')
    } else {
      console.log('✗ Bash execution failed\n')
    }

    console.log('='.repeat(60))
    console.log('ALL TESTS COMPLETED')
    console.log('='.repeat(60))

  } catch (error) {
    console.error('Test failed:', error)
    process.exit(1)
  }
}

main().catch(console.error)
