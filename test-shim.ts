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

  console.log('=== Shell Shim Diagnostics ===\n')

  // Check if shim is installed
  console.log('1. Check shim installation:')
  const whichShim = await runCommand(sandboxUrl, token, 'which agentsh-shell-shim || echo "not found"')
  console.log(`   agentsh-shell-shim: ${whichShim.stdout.trim()}`)

  // Check if shim binary exists
  const lsShim = await runCommand(sandboxUrl, token, 'ls -la /usr/bin/agentsh-shell-shim /usr/local/bin/agentsh-shell-shim 2>/dev/null || echo "shim binary not found"')
  console.log(`   ${lsShim.stdout.trim()}`)

  // Check if shim is in /etc/shells
  const etcShells = await runCommand(sandboxUrl, token, 'cat /etc/shells 2>/dev/null || echo "no /etc/shells"')
  console.log(`\n2. /etc/shells contents:`)
  console.log(etcShells.stdout)

  // Check current shell
  const currentShell = await runCommand(sandboxUrl, token, 'echo $SHELL')
  console.log(`3. Current SHELL: ${currentShell.stdout.trim()}`)

  // Check if bash is symlinked to shim
  console.log('\n4. Check shell binaries:')
  const lsBash = await runCommand(sandboxUrl, token, 'ls -la /bin/bash /bin/sh 2>/dev/null || true')
  console.log(lsBash.stdout)

  // Check shim/unix_sockets config
  console.log('5. Check unix_sockets in config.yaml:')
  const shimConfig = await runCommand(sandboxUrl, token, 'grep -A5 "unix_sockets" /etc/agentsh/config.yaml || echo "not configured"')
  console.log(shimConfig.stdout)

  // Test: Run bash -c directly (not through agentsh) with a blocked command
  console.log('6. Test direct bash -c with blocked command (sudo):')
  const bashSudo = await runCommand(sandboxUrl, token, 'bash -c "sudo whoami" 2>&1')
  console.log(`   Exit code: ${bashSudo.exitCode}`)
  console.log(`   Output: ${(bashSudo.stdout + bashSudo.stderr).trim().substring(0, 200)}`)

  // Test: Run bash -c directly with allowed command
  console.log('\n7. Test direct bash -c with allowed command (echo):')
  const bashEcho = await runCommand(sandboxUrl, token, 'bash -c "echo hello from bash"')
  console.log(`   Exit code: ${bashEcho.exitCode}`)
  console.log(`   Output: ${bashEcho.stdout.trim()}`)

  // Test via agentsh exec with bash -c and blocked command
  console.log('\n8. Test agentsh exec with bash -c (blocked sudo):')
  const agentshBashSudo = await runCommand(sandboxUrl, token,
    'agentsh exec test-shim --timeout 10s -- /bin/bash -c "sudo whoami" 2>&1')
  console.log(`   Exit code: ${agentshBashSudo.exitCode}`)
  const output = agentshBashSudo.stdout + agentshBashSudo.stderr + agentshBashSudo.logs
  if (output.includes('denied') || output.includes('blocked')) {
    console.log(`   ✓ BLOCKED correctly`)
  } else {
    console.log(`   Output: ${output.substring(0, 300)}`)
  }

  // Test: Check if commands run outside agentsh exec are enforced
  console.log('\n9. Test if direct commands (outside agentsh exec) are enforced:')
  console.log('   Running "sudo ls" directly through sandbox API...')
  const directSudo = await runCommand(sandboxUrl, token, 'sudo ls 2>&1')
  console.log(`   Exit code: ${directSudo.exitCode}`)
  const directOutput = directSudo.stdout + directSudo.stderr
  if (directSudo.exitCode !== 0 && (directOutput.includes('denied') || directOutput.includes('blocked') || directOutput.includes('not permitted'))) {
    console.log(`   ✓ Direct sudo BLOCKED (shim working)`)
  } else if (directSudo.exitCode === 0) {
    console.log(`   ✗ Direct sudo ALLOWED (shim NOT enforcing)`)
    console.log(`   Output: ${directOutput.substring(0, 200)}`)
  } else {
    console.log(`   Output: ${directOutput.substring(0, 200)}`)
  }

  console.log('\n=== Summary ===')
  console.log('The shell shim (agentsh-shell-shim) intercepts bash/sh to enforce')
  console.log('policies on commands run outside of agentsh exec.')
  console.log('If test #9 shows "BLOCKED", the shim is working correctly.')
}

main().catch(console.error)
