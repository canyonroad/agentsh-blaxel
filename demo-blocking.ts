import 'dotenv/config'
import { execSync } from 'child_process'

// Blaxel sandbox policy blocking demo
// Demonstrates agentsh policy enforcement via the shell shim
//
// Architecture: The agentsh shell shim replaces /bin/sh and /bin/bash,
// so ALL commands run through the sandbox API are automatically intercepted
// and enforced by agentsh policy. No explicit `agentsh exec` calls needed.

const SANDBOX_NAME = 'agentsh-blaxel'

interface ProcessResult {
  pid: string
  status: string
  exitCode: number
  stdout: string
  stderr: string
  logs: string
}

interface AgentshEvent {
  id: string
  type: string
  session_id: string
  policy: {
    decision: string
    effective_decision: string
    rule: string
    message?: string
  }
  filename?: string
  argv?: string[]
  effective_action?: string
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

// Query agentsh events to find the policy rule that blocked a command
async function getBlockedRule(sandboxUrl: string, token: string, command: string): Promise<string | null> {
  try {
    const result = await runCommand(sandboxUrl, token,
      `/usr/bin/agentsh events query --decision deny --type execve --limit 5 2>&1`, 10000)
    const output = result.stdout || result.logs
    const events: AgentshEvent[] = JSON.parse(output)

    // Find the event matching our command
    const basename = command.split('/').pop() || command
    for (const event of events) {
      if (event.argv?.[0]?.includes(basename) || event.filename?.includes(basename)) {
        return event.policy.rule
      }
    }
  } catch {
    // Events query failed, return null
  }
  return null
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

  // Verify agentsh is running
  const versionResult = await runCommand(sandboxUrl, token, '/usr/bin/agentsh --version 2>&1')
  console.log(`agentsh version: ${(versionResult.stdout || versionResult.logs).trim()}`)
  console.log('Shell shim active: commands enforced via /bin/sh interception\n')

  // Helper to run a command and report result
  async function testCommand(description: string, command: string): Promise<boolean> {
    console.log(`\n--- ${description} ---`)

    try {
      const result = await runCommand(sandboxUrl, token, command, 15000)

      if (result.exitCode === 0) {
        console.log(`✓ ALLOWED (exit: ${result.exitCode})`)
        const output = (result.stdout || result.logs).trim()
        if (output) {
          console.log(`  Output: ${output.split('\n')[0]}`)
        }
        return true
      } else if (result.exitCode === 126) {
        // Exit 126 = command blocked by seccomp policy
        const rule = await getBlockedRule(sandboxUrl, token, command.split(' ')[0])
        console.log(`✗ BLOCKED by ${rule || 'policy'} (exit: 126)`)
        return false
      } else {
        console.log(`✗ FAILED (exit: ${result.exitCode})`)
        const stderr = (result.stderr || '').trim()
        if (stderr) {
          console.log(`  Error: ${stderr.split('\n')[0]}`)
        }
        return false
      }
    } catch (e: any) {
      console.log(`✗ ERROR: ${e.message}`)
      return false
    }
  }

  console.log('='.repeat(60))
  console.log('1. ALLOWED COMMANDS')
  console.log('='.repeat(60))

  await testCommand('echo Hello', 'echo Hello')
  await testCommand('pwd', 'pwd')
  await testCommand('ls /app', 'ls /app')
  await testCommand('date', 'date')
  await testCommand('cat /etc/hostname', 'cat /etc/hostname')

  console.log('\n' + '='.repeat(60))
  console.log('2. BLOCKED: Privilege Escalation')
  console.log('='.repeat(60))

  await testCommand('/usr/bin/sudo whoami', '/usr/bin/sudo whoami')
  await testCommand('/bin/su -', '/bin/su -')

  console.log('\n' + '='.repeat(60))
  console.log('3. BLOCKED: Network Tools')
  console.log('='.repeat(60))

  await testCommand('/usr/bin/ssh localhost', '/usr/bin/ssh localhost')
  await testCommand('nc -h', 'nc -h')

  console.log('\n' + '='.repeat(60))
  console.log('4. BLOCKED: System Commands')
  console.log('='.repeat(60))

  await testCommand('/bin/kill -9 1', '/bin/kill -9 1')
  await testCommand('/sbin/shutdown now', '/sbin/shutdown now')

  console.log('\n' + '='.repeat(60))
  console.log('5. BLOCKED: Recursive Delete')
  console.log('='.repeat(60))

  // Create test directory first
  await runCommand(sandboxUrl, token, 'mkdir -p /tmp/test && touch /tmp/test/file.txt')

  await testCommand('/bin/rm -rf /tmp/test', '/bin/rm -rf /tmp/test')
  await testCommand('/bin/rm -r /tmp/test', '/bin/rm -r /tmp/test')

  console.log('\n' + '='.repeat(60))
  console.log('6. ALLOWED: Single File Delete')
  console.log('='.repeat(60))

  // Create test file
  await runCommand(sandboxUrl, token, 'mkdir -p /tmp/test && touch /tmp/test/file.txt')
  await testCommand('rm /tmp/test/file.txt', 'rm /tmp/test/file.txt')

  // Show full audit trail
  console.log('\n' + '='.repeat(60))
  console.log('7. AUDIT TRAIL (recent blocked events)')
  console.log('='.repeat(60))

  try {
    const eventsResult = await runCommand(sandboxUrl, token,
      '/usr/bin/agentsh events query --decision deny --type execve --limit 10 2>&1', 10000)
    const events: AgentshEvent[] = JSON.parse(eventsResult.stdout || eventsResult.logs)
    console.log('')
    for (const event of events) {
      const cmd = event.argv?.join(' ') || event.filename || 'unknown'
      const rule = event.policy.rule
      const msg = event.policy.message ? ` - ${event.policy.message}` : ''
      console.log(`  ✗ ${cmd.padEnd(30)} rule: ${rule}${msg}`)
    }
  } catch {
    console.log('  (unable to query events)')
  }

  console.log('\n' + '='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))
  console.log(`
agentsh policy enforcement via shell shim:

  The shell shim (/bin/sh, /bin/bash) intercepts ALL commands
  and enforces policy at the seccomp/execve level.

BLOCKED:
  ✗ sudo, su           → block-shell-escape
  ✗ ssh, nc            → block-network-tools
  ✗ kill, shutdown     → block-system-commands
  ✗ rm -r, rm -rf      → block-rm-recursive

ALLOWED:
  ✓ echo, pwd, ls      → allow-safe-commands
  ✓ cat, date          → allow-safe-commands
  ✓ rm (single file)   → redirect-rm-to-safe (quarantined)
`)

  console.log('Demo completed.')
}

main().catch(console.error)
