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

  console.log('=== Testing kill command variations ===\n')

  // Test 1: bash built-in kill
  console.log('1. kill -9 1 (bash built-in):')
  const r1 = await runCommand(sandboxUrl, token, 'kill -9 1 2>&1; echo "exit=$?"')
  console.log(`   Exit: ${r1.exitCode}, Output: ${r1.stdout.trim()}`)

  // Test 2: /bin/kill (external command)
  console.log('\n2. /bin/kill -9 1 (external command):')
  const r2 = await runCommand(sandboxUrl, token, '/bin/kill -9 1 2>&1; echo "exit=$?"')
  console.log(`   Exit: ${r2.exitCode}, Output: ${r2.stdout.trim()}`)

  // Test 3: Check if /bin/kill exists
  console.log('\n3. Check /bin/kill existence:')
  const r3 = await runCommand(sandboxUrl, token, 'ls -la /bin/kill 2>&1 || which kill')
  console.log(`   ${r3.stdout.trim()}`)

  // Test 4: Use command to bypass built-in
  console.log('\n4. command kill -9 1 (force external):')
  const r4 = await runCommand(sandboxUrl, token, 'command kill -9 1 2>&1; echo "exit=$?"')
  console.log(`   Exit: ${r4.exitCode}, Output: ${r4.stdout.trim()}`)

  // Test 5: Disable built-in and try kill
  console.log('\n5. enable -n kill; kill -9 1 (disable built-in):')
  const r5 = await runCommand(sandboxUrl, token, 'enable -n kill; kill -9 1 2>&1; echo "exit=$?"')
  console.log(`   Exit: ${r5.exitCode}, Output: ${r5.stdout.trim()}`)
}

main().catch(console.error)
