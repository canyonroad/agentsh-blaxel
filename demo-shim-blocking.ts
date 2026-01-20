import 'dotenv/config'
import { execSync } from 'child_process'

// Blaxel sandbox policy blocking demo using shell shim
// The shell shim intercepts all commands run through /bin/sh and /bin/bash

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
  console.log('AGENTSH SHELL SHIM BLOCKING DEMO')
  console.log('='.repeat(60))

  const token = getToken()
  const sandboxUrl = getSandboxUrl()

  if (!sandboxUrl) {
    console.error('Sandbox not found. Run: bl deploy')
    process.exit(1)
  }

  console.log(`\nSandbox URL: ${sandboxUrl}`)
  console.log('Shell shim intercepts all commands through /bin/bash and /bin/sh\n')

  // Helper to run command via bash (shim)
  async function runViaShim(description: string, cmd: string): Promise<boolean> {
    console.log(`\n--- ${description} ---`)

    try {
      const result = await runCommand(sandboxUrl, token, cmd, 15000)
      const output = result.stdout + result.stderr + result.logs

      if (result.exitCode === 0) {
        console.log(`✓ ALLOWED (exit: ${result.exitCode})`)
        if (result.stdout.trim()) {
          const firstLine = result.stdout.trim().split('\n')[0]
          console.log(`  Output: ${firstLine.substring(0, 60)}${firstLine.length > 60 ? '...' : ''}`)
        }
        return true
      } else if (result.exitCode === 126 || output.includes('agentsh: command failed')) {
        // Exit 126 = command blocked by shim
        console.log(`✗ BLOCKED by shim (exit: ${result.exitCode})`)
        return false
      } else if (output.includes('not found')) {
        console.log(`✗ NOT FOUND (command not installed)`)
        return false
      } else {
        console.log(`✗ FAILED (exit: ${result.exitCode})`)
        if (result.stderr.trim()) {
          console.log(`  Error: ${result.stderr.trim().substring(0, 100)}`)
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

  await runViaShim('echo Hello', 'echo Hello')
  await runViaShim('pwd', 'pwd')
  await runViaShim('ls /app', 'ls /app')
  await runViaShim('date', 'date')
  await runViaShim('cat /etc/hostname', 'cat /etc/hostname')
  await runViaShim('whoami', 'whoami')

  console.log('\n' + '='.repeat(60))
  console.log('2. BLOCKED: Privilege Escalation')
  console.log('='.repeat(60))

  await runViaShim('sudo whoami', 'sudo whoami')
  await runViaShim('su -', 'su -')

  console.log('\n' + '='.repeat(60))
  console.log('3. BLOCKED: Network Tools')
  console.log('='.repeat(60))

  await runViaShim('ssh localhost', 'ssh localhost')
  await runViaShim('nc -h', 'nc -h')

  console.log('\n' + '='.repeat(60))
  console.log('4. BLOCKED: System Commands')
  console.log('='.repeat(60))

  await runViaShim('kill -9 1', 'kill -9 1')
  await runViaShim('shutdown now', 'shutdown now')

  console.log('\n' + '='.repeat(60))
  console.log('5. BLOCKED: Recursive Delete')
  console.log('='.repeat(60))

  // Create test directory first
  await runCommand(sandboxUrl, token, 'mkdir -p /tmp/test && touch /tmp/test/file.txt')

  await runViaShim('rm -rf /tmp/test', 'rm -rf /tmp/test')
  await runViaShim('rm -r /tmp/test', 'rm -r /tmp/test')

  console.log('\n' + '='.repeat(60))
  console.log('6. ALLOWED: Single File Delete')
  console.log('='.repeat(60))

  // Create test file
  await runCommand(sandboxUrl, token, 'mkdir -p /tmp/test && touch /tmp/test/file.txt')
  await runViaShim('rm /tmp/test/file.txt', 'rm /tmp/test/file.txt')

  console.log('\n' + '='.repeat(60))
  console.log('7. VERIFICATION: Shim vs Real Bash')
  console.log('='.repeat(60))

  console.log('\n--- Shim intercepts /bin/bash ---')
  await runViaShim('/bin/bash -c "sudo ls"', '/bin/bash -c "sudo ls"')

  console.log('\n--- Real bash bypasses shim ---')
  await runViaShim('/bin/bash.real -c "echo real bash works"', '/bin/bash.real -c "echo real bash works"')

  console.log('\n' + '='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))
  console.log(`
Shell shim enforcement in action:

BLOCKED (exit 126):
  ✗ sudo, su           → Privilege escalation blocked
  ✗ ssh, nc            → Network tools blocked
  ✗ kill, shutdown     → System commands blocked
  ✗ rm -r, rm -rf      → Recursive delete blocked

ALLOWED:
  ✓ echo, pwd, ls      → Standard commands
  ✓ cat, date, whoami  → File reading, utilities
  ✓ rm (single file)   → Non-recursive delete

The shell shim (/bin/bash, /bin/sh) enforces agentsh policies
on ALL commands run through the sandbox API.
`)

  console.log('Demo completed.')
}

main().catch(console.error)
