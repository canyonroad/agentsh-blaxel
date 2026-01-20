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

  console.log('=== Debug shim behavior ===\n')

  // Test 1: Direct command without agentsh
  console.log('1. Direct echo (should work):')
  const echo1 = await runCommand(sandboxUrl, token, 'echo hello')
  console.log(`   Exit: ${echo1.exitCode}, Output: "${echo1.stdout.trim()}"`)
  console.log(`   Stderr: "${echo1.stderr.trim()}"`)
  console.log(`   Logs: "${echo1.logs.trim()}"`)

  // Test 2: Using /bin/echo explicitly
  console.log('\n2. /bin/echo directly (should work):')
  const echo2 = await runCommand(sandboxUrl, token, '/bin/echo hello')
  console.log(`   Exit: ${echo2.exitCode}, Output: "${echo2.stdout.trim()}"`)
  console.log(`   Stderr: "${echo2.stderr.trim()}"`)

  // Test 3: Using bash.real to run echo
  console.log('\n3. /bin/bash.real -c "echo hello" (should work):')
  const echo3 = await runCommand(sandboxUrl, token, '/bin/bash.real -c "echo hello"')
  console.log(`   Exit: ${echo3.exitCode}, Output: "${echo3.stdout.trim()}"`)
  console.log(`   Stderr: "${echo3.stderr.trim()}"`)

  // Test 4: Using bash (shim) to run echo
  console.log('\n4. /bin/bash -c "echo hello" (through shim):')
  const echo4 = await runCommand(sandboxUrl, token, '/bin/bash -c "echo hello"')
  console.log(`   Exit: ${echo4.exitCode}, Output: "${echo4.stdout.trim()}"`)
  console.log(`   Stderr: "${echo4.stderr.trim()}"`)

  // Test 5: Using bash (shim) to run sudo
  console.log('\n5. /bin/bash -c "sudo ls" (should be blocked):')
  const sudo1 = await runCommand(sandboxUrl, token, '/bin/bash -c "sudo ls"')
  console.log(`   Exit: ${sudo1.exitCode}, Output: "${sudo1.stdout.trim()}"`)
  console.log(`   Stderr: "${sudo1.stderr.trim()}"`)

  // Test 6: agentsh exec with echo
  console.log('\n6. agentsh exec with /bin/echo:')
  const agentsh1 = await runCommand(sandboxUrl, token, 'agentsh exec test-sess --timeout 10s -- /bin/echo hello')
  console.log(`   Exit: ${agentsh1.exitCode}`)
  console.log(`   Output: "${agentsh1.stdout.trim()}"`)
  console.log(`   Stderr: "${agentsh1.stderr.trim()}"`)
  console.log(`   Logs: "${agentsh1.logs?.trim() || ''}"`)

  // Test 7: Check which shell sandbox-api uses
  console.log('\n7. Check sandbox shell:')
  const shell1 = await runCommand(sandboxUrl, token, 'ls -la /bin/sh /bin/bash')
  console.log(`   ${shell1.stdout.trim()}`)

  // Test 8: Check if bash.real exists
  console.log('\n8. Check bash.real:')
  const bash1 = await runCommand(sandboxUrl, token, 'ls -la /bin/bash.real /bin/sh.real 2>&1')
  console.log(`   ${bash1.stdout.trim()}`)
}

main().catch(console.error)
