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

  console.log('=== Debug BASH_ENV ===\n')

  // Check BASH_ENV
  console.log('1. Check BASH_ENV:')
  const r1 = await runCommand(sandboxUrl, token, 'echo "BASH_ENV=$BASH_ENV"')
  console.log(`   ${r1.stdout.trim()}`)

  // Check if bash.bashrc exists
  console.log('\n2. Check /etc/bash.bashrc:')
  const r2 = await runCommand(sandboxUrl, token, 'cat /etc/bash.bashrc')
  console.log(`   ${r2.stdout.trim()}`)

  // Check if kill built-in is enabled
  console.log('\n3. Check if kill built-in is enabled:')
  const r3 = await runCommand(sandboxUrl, token, 'type kill')
  console.log(`   ${r3.stdout.trim()}`)

  // Try explicitly sourcing bashrc and then running kill
  console.log('\n4. Source bashrc then type kill:')
  const r4 = await runCommand(sandboxUrl, token, 'source /etc/bash.bashrc 2>/dev/null; type kill')
  console.log(`   ${r4.stdout.trim()}`)

  // Check env
  console.log('\n5. Full environment:')
  const r5 = await runCommand(sandboxUrl, token, 'env | grep -E "BASH|AGENT|PATH"')
  console.log(`   ${r5.stdout.trim()}`)
}

main().catch(console.error)
