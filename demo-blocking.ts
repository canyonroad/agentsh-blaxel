import 'dotenv/config'
import { execSync } from 'child_process'

// Blaxel sandbox policy blocking demo
// Demonstrates agentsh policy enforcement

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
  console.log('='.repeat(60))
  console.log('AGENTSH POLICY BLOCKING DEMO')
  console.log('='.repeat(60))

  const token = getToken()
  const sandboxUrl = getSandboxUrl()

  if (!sandboxUrl) {
    console.error('Sandbox not found. Run: bl deploy')
    process.exit(1)
  }

  console.log(`\nSandbox URL: ${sandboxUrl}\n`)

  // Create a session first
  console.log('=== Creating agentsh session ===')
  const sessionResult = await runCommand(sandboxUrl, token,
    'agentsh session create --workspace /app --json')
  let sessionId: string
  try {
    const sessionData = JSON.parse(sessionResult.stdout)
    sessionId = sessionData.id
    console.log(`Session ID: ${sessionId}\n`)
  } catch {
    // Fallback session name
    sessionId = 'demo-session'
    console.log(`Using session: ${sessionId}\n`)
  }

  // Helper to run command via agentsh exec
  async function runAgentsh(description: string, cmd: string, args: string[] = []): Promise<boolean> {
    console.log(`\n--- ${description} ---`)

    const fullCmd = args.length > 0
      ? `agentsh exec ${sessionId} --timeout 15s -- ${cmd} ${args.map(a => `"${a}"`).join(' ')}`
      : `agentsh exec ${sessionId} --timeout 15s -- ${cmd}`

    try {
      const result = await runCommand(sandboxUrl, token, fullCmd, 20000)

      if (result.exitCode === 0) {
        console.log(`✓ ALLOWED (exit: ${result.exitCode})`)
        if (result.stdout.trim()) {
          console.log(`  Output: ${result.stdout.trim().split('\n')[0]}`)
        }
        return true
      } else {
        const output = result.stdout + result.stderr + result.logs
        if (output.includes('denied') || output.includes('blocked') || output.includes('not permitted')) {
          const ruleMatch = output.match(/rule[=:]([^\s\)]+)/)
          const rule = ruleMatch ? ruleMatch[1] : 'policy'
          console.log(`✗ BLOCKED by ${rule}`)
        } else if (output.includes('no such file')) {
          console.log(`✗ NOT FOUND (command not installed)`)
        } else {
          console.log(`✗ FAILED (exit: ${result.exitCode})`)
        }
        return false
      }
    } catch (e: any) {
      console.log(`✗ ERROR: ${e.message}`)
      return false
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log('1. ALLOWED COMMANDS')
  console.log('='.repeat(60))

  await runAgentsh('/bin/echo Hello', '/bin/echo', ['Hello'])
  await runAgentsh('/bin/pwd', '/bin/pwd')
  await runAgentsh('/bin/ls /app', '/bin/ls', ['/app'])
  await runAgentsh('/bin/date', '/bin/date')
  await runAgentsh('/bin/cat /etc/hostname', '/bin/cat', ['/etc/hostname'])

  console.log('\n' + '='.repeat(60))
  console.log('2. BLOCKED: Privilege Escalation')
  console.log('='.repeat(60))

  await runAgentsh('/usr/bin/sudo whoami', '/usr/bin/sudo', ['whoami'])
  await runAgentsh('/bin/su -', '/bin/su', ['-'])

  console.log('\n' + '='.repeat(60))
  console.log('3. BLOCKED: Network Tools')
  console.log('='.repeat(60))

  await runAgentsh('/usr/bin/ssh localhost', '/usr/bin/ssh', ['localhost'])
  await runAgentsh('/bin/nc -h', '/bin/nc', ['-h'])

  console.log('\n' + '='.repeat(60))
  console.log('4. BLOCKED: System Commands')
  console.log('='.repeat(60))

  await runAgentsh('/bin/kill -9 1', '/bin/kill', ['-9', '1'])
  await runAgentsh('/sbin/shutdown now', '/sbin/shutdown', ['now'])

  console.log('\n' + '='.repeat(60))
  console.log('5. BLOCKED: Recursive Delete')
  console.log('='.repeat(60))

  // Create test directory first
  await runCommand(sandboxUrl, token, 'mkdir -p /tmp/test && touch /tmp/test/file.txt')

  await runAgentsh('/bin/rm -rf /tmp/test', '/bin/rm', ['-rf', '/tmp/test'])
  await runAgentsh('/bin/rm -r /tmp/test', '/bin/rm', ['-r', '/tmp/test'])

  console.log('\n' + '='.repeat(60))
  console.log('6. ALLOWED: Single File Delete')
  console.log('='.repeat(60))

  // Create test file
  await runCommand(sandboxUrl, token, 'mkdir -p /tmp/test && touch /tmp/test/file.txt')
  await runAgentsh('/bin/rm /tmp/test/file.txt', '/bin/rm', ['/tmp/test/file.txt'])

  console.log('\n' + '='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))
  console.log(`
agentsh policy enforcement in action:

BLOCKED:
  ✗ sudo, su           → Privilege escalation blocked
  ✗ ssh, nc            → Network tools blocked
  ✗ kill, shutdown     → System commands blocked
  ✗ rm -r, rm -rf      → Recursive delete blocked

ALLOWED:
  ✓ echo, pwd, ls      → Standard commands
  ✓ cat, date          → File reading, utilities
  ✓ rm (single file)   → Non-recursive delete
`)

  console.log('Demo completed.')
}

main().catch(console.error)
