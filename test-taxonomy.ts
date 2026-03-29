import 'dotenv/config'
import { getToken, getSandboxUrl, waitForSandbox, runCommand, getOutput } from './sandbox-utils.js'

// Agent Sandbox Taxonomy (AST) probe runner
// https://github.com/kajogo777/the-agent-sandbox-taxonomy

const SANDBOX_NAME = 'agentsh-blaxel'

function strengthLabel(s: number): string {
  const labels: Record<number, string> = {
    [-1]: 'not assessed', 0: 'none', 1: 'cooperative',
    2: 'software-enforced', 3: 'kernel-enforced', 4: 'structural'
  }
  return labels[s] ?? `unknown(${s})`
}

function coverageIcon(c: string): string {
  return c === 'full' ? '\u25cf' : c === 'partial' ? '\u25d0' : '\u25cb'
}

const LAYER_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'] as const

async function main() {
  console.log('='.repeat(60))
  console.log('AGENT SANDBOX TAXONOMY (AST) PROBE')
  console.log('='.repeat(60))

  const token = getToken()
  const sandboxUrl = getSandboxUrl(SANDBOX_NAME)
  if (!sandboxUrl) {
    console.error('Sandbox not found. Run: bl deploy')
    process.exit(1)
  }
  console.log(`\nSandbox URL: ${sandboxUrl}`)

  process.stdout.write('Waiting for sandbox to be ready...')
  await waitForSandbox(sandboxUrl, token)
  console.log(' ready!\n')

  console.log('Running ast-probe (may take ~30s for network tests)...')
  const result = await runCommand(
    sandboxUrl, token,
    '/usr/local/bin/ast-probe --product agentsh-blaxel --quiet',
    120000
  )

  const output = getOutput(result)

  // The probe may crash with SIGSYS (exit 159) if seccomp kills it on mount()
  // In that case, fall back to running with --version to confirm it's there,
  // and report the crash
  if (result.exitCode === 159) {
    console.log('\nast-probe was killed by seccomp (SIGSYS, exit 159)')
    console.log('This means a dangerous syscall (likely mount) was blocked with SECCOMP_RET_KILL')
    console.log('This is actually GOOD for security (kernel-enforced blocking)')
    console.log('But it means the probe cannot complete all 7 layers.')
    console.log('\nTo get full results, deploy with security.mode: "hybrid" in config.yaml')
    console.log('(hybrid uses ptrace which returns errno instead of killing)')
    process.exit(0)
  }

  if (result.exitCode !== 0) {
    console.error(`\nast-probe exited with code ${result.exitCode}`)
    console.error(`Output: ${output}`)
    process.exit(1)
  }

  let report: any
  try {
    report = JSON.parse(output)
  } catch {
    console.error('\nFailed to parse JSON:')
    console.error(output.substring(0, 500))
    process.exit(1)
  }

  // Display scorecard
  console.log('\n' + '='.repeat(60))
  console.log('SCORECARD')
  console.log('='.repeat(60))

  console.log(`\nProduct:     ${report.product}`)
  console.log(`Timestamp:   ${report.timestamp}`)
  console.log(`Fingerprint: ${report.fingerprint}`)

  // Per-layer breakdown (layers are top-level keys L1-L7)
  console.log('\n--- Defense Layers ---\n')
  console.log(`${'Layer'.padEnd(6)} ${'S'.padEnd(3)} ${'Mechanism'.padEnd(28)} Notes`)
  console.log('-'.repeat(78))

  let totalS = 0
  for (const lid of LAYER_IDS) {
    const layer = report[lid]
    if (!layer) continue
    const s = layer.assessed_strength ?? -1
    if (s >= 0) totalS += s
    const mech = layer.detected_mechanism ?? ''
    const notes = layer.notes ?? ''
    const sLabel = `${s} (${strengthLabel(s)})`
    console.log(`${lid.padEnd(6)} ${sLabel.padEnd(24)} ${mech.padEnd(28)}`)
    if (notes) console.log(`       ${notes}`)

    // Warnings
    if (Array.isArray(layer.warnings) && layer.warnings.length > 0) {
      for (const w of layer.warnings) {
        console.log(`       \u26a0 ${w}`)
      }
    }
    console.log()
  }

  // Threat coverage
  if (Array.isArray(report.threats)) {
    console.log('--- Threat Coverage ---\n')
    for (const t of report.threats) {
      const icon = coverageIcon(t.rating)
      console.log(`${icon} ${t.threat.padEnd(25)} ${t.rating.padEnd(8)} ${t.detail}`)
    }
  }

  // Detailed test results
  console.log('\n--- Detailed Test Results ---\n')
  for (const lid of LAYER_IDS) {
    const layer = report[lid]
    if (!layer?.tests?.length) continue
    console.log(`${lid}: ${layer.detected_mechanism}`)
    for (const test of layer.tests) {
      const icon = test.result === 'blocked' ? '\u2713' :
                   test.result === 'allowed' ? '\u2717' :
                   test.result === 'detected' ? '\u00b7' : '?'
      console.log(`  ${icon} ${test.name}: ${test.detail?.substring(0, 100) ?? ''}`)
    }
    console.log()
  }

  // Summary
  const maxS = LAYER_IDS.length * 4
  const full = report.threats?.filter((t: any) => t.rating === 'full').length ?? 0
  const partial = report.threats?.filter((t: any) => t.rating === 'partial').length ?? 0
  const total = report.threats?.length ?? 0

  console.log('='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))
  console.log(`\nFingerprint:     ${report.fingerprint}`)
  console.log(`Total Strength:  ${totalS}/${maxS} (${((totalS / maxS) * 100).toFixed(0)}%)`)
  console.log(`Threats:         ${full} full, ${partial} partial, ${total - full - partial} none (of ${total})`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
