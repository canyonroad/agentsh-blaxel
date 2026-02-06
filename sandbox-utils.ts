import { execSync } from 'child_process'

export interface ProcessResult {
  pid: string
  status: string
  exitCode: number
  stdout: string
  stderr: string
  logs: string
}

export interface AgentshEvent {
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

export function getToken(): string {
  return execSync('bl token', { encoding: 'utf-8' }).trim()
}

export function getSandboxUrl(sandboxName: string): string {
  const output = execSync(`bl get sandbox ${sandboxName} -o json`, { encoding: 'utf-8' })
  const data = JSON.parse(output)
  return data[0]?.metadata?.url
}

// Get output from a process result (sandbox may return in stdout or logs)
export function getOutput(result: ProcessResult): string {
  return (result.stdout || result.logs || '').trim()
}

// Wait for sandbox to be ready (cold start can take ~60s)
export async function waitForSandbox(sandboxUrl: string, token: string, maxWait = 90000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`${sandboxUrl}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ command: 'echo ready' })
      })
      if (res.ok) {
        const { pid } = await res.json() as { pid: string }
        for (let i = 0; i < 20; i++) {
          const status = await fetch(`${sandboxUrl}/process/${pid}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          const result = await status.json() as ProcessResult
          if (result.status === 'completed' || result.status === 'failed') return
          await new Promise(r => setTimeout(r, 500))
        }
        return
      }
    } catch {
      // Sandbox not ready yet
    }
    process.stdout.write('.')
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error('Sandbox did not become ready')
}

export async function runCommand(sandboxUrl: string, token: string, command: string, timeout = 30000): Promise<ProcessResult> {
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
