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

  console.log('=== Test enable -n kill ===\n')

  // Test 1: Check type kill before
  console.log('1. type kill (before):')
  const r1 = await runCommand(sandboxUrl, token, 'type kill')
  console.log(`   ${r1.stdout.trim()}`)

  // Test 2: enable -n kill in same shell then type kill
  console.log('\n2. enable -n kill; type kill (same shell):')
  const r2 = await runCommand(sandboxUrl, token, 'enable -n kill; type kill')
  console.log(`   ${r2.stdout.trim() || r2.stderr.trim()}`)

  // Test 3: Check if /bin/kill is used after disabling builtin
  console.log('\n3. enable -n kill; kill -9 1; echo exit=$?:')
  const r3 = await runCommand(sandboxUrl, token, 'enable -n kill; kill -9 1 2>&1; echo "exit=$?"')
  console.log(`   ${r3.stdout.trim()}`)

  // Test 4: What shell are we using?
  console.log('\n4. Check shell:')
  const r4 = await runCommand(sandboxUrl, token, 'echo $0; ls -la /proc/$$/exe')
  console.log(`   ${r4.stdout.trim()}`)

  // Test 5: Is it really bash.real?
  console.log('\n5. Bash version:')
  const r5 = await runCommand(sandboxUrl, token, 'echo "$BASH_VERSION"')
  console.log(`   ${r5.stdout.trim()}`)
}

main().catch(console.error)
