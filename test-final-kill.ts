import 'dotenv/config'
import { execSync } from 'child_process'

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
  const token = getToken()
  const sandboxUrl = getSandboxUrl()

  console.log('=== Final kill test with BASH_ENV ===\n')

  // Check where kill is
  console.log('1. Check kill locations:')
  const r1 = await runCommand(sandboxUrl, token, 'ls -la /bin/kill /usr/bin/kill 2>&1')
  console.log(`   ${r1.stdout.trim()}`)

  // Test with BASH_ENV and correct PATH
  console.log('\n2. BASH_ENV test with /bin/kill:')
  const r2 = await runCommand(sandboxUrl, token, 'BASH_ENV=/etc/bash.bashrc /bin/bash -c "type kill; /bin/kill -9 1 2>&1; echo exit=\\$?"')
  console.log(`   Exit: ${r2.exitCode}`)
  console.log(`   Output: ${r2.stdout.trim()}`)
  console.log(`   Stderr: ${r2.stderr.trim()}`)

  // The real test - with BASH_ENV, kill should be blocked
  console.log('\n3. Kill with BASH_ENV (should be BLOCKED):')
  const r3 = await runCommand(sandboxUrl, token, 'BASH_ENV=/etc/bash.bashrc /bin/bash -c "kill -9 1 2>&1; echo exit=\\$?"')
  console.log(`   Exit: ${r3.exitCode}`)
  console.log(`   Output: ${r3.stdout.trim()}`)
  const output = r3.stdout + r3.stderr
  if (output.includes('Success') || r3.exitCode === 126 || r3.exitCode === 127) {
    console.log('   ✓ BLOCKED!')
  } else {
    console.log('   ✗ Not blocked')
  }

  // Without BASH_ENV for comparison
  console.log('\n4. Kill WITHOUT BASH_ENV (built-in, not blocked):')
  const r4 = await runCommand(sandboxUrl, token, '/bin/bash -c "kill -9 1 2>&1; echo exit=\\$?"')
  console.log(`   Exit: ${r4.exitCode}`)
  console.log(`   Output: ${r4.stdout.trim()}`)
}

main().catch(console.error)
