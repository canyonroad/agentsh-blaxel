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

  console.log('=== Test bash -c kill (AI agent scenario) ===\n')

  // This is what an AI agent would run
  console.log('1. /bin/bash -c "kill -9 1" (AI agent style):')
  const r1 = await runCommand(sandboxUrl, token, '/bin/bash -c "kill -9 1" 2>&1; echo "exit=$?"')
  console.log(`   Exit: ${r1.exitCode}`)
  console.log(`   Output: ${r1.stdout.trim()}`)
  console.log(`   Stderr: ${r1.stderr.trim()}`)

  // Check what shell bash -c uses
  console.log('\n2. /bin/bash -c "echo \\$0; echo \\$BASH_VERSION":')
  const r2 = await runCommand(sandboxUrl, token, '/bin/bash -c "echo \\$0; echo \\$BASH_VERSION"')
  console.log(`   ${r2.stdout.trim()}`)

  // Check type kill in bash
  console.log('\n3. /bin/bash -c "type kill":')
  const r3 = await runCommand(sandboxUrl, token, '/bin/bash -c "type kill"')
  console.log(`   ${r3.stdout.trim()}`)

  // Test with BASH_ENV
  console.log('\n4. BASH_ENV=/etc/bash.bashrc /bin/bash -c "type kill; kill -9 1; echo exit=\\$?"')
  const r4 = await runCommand(sandboxUrl, token, 'BASH_ENV=/etc/bash.bashrc /bin/bash -c "type kill; kill -9 1 2>&1; echo exit=\\$?"')
  console.log(`   ${r4.stdout.trim()}`)
}

main().catch(console.error)
