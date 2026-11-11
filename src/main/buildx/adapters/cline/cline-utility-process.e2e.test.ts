import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const req = createRequire(path.join(process.cwd(), 'package.json'))

async function runInRealElectron(payload: {
  readonly mode: 'gates' | 'real-unit'
  readonly includeHardKillWorker?: boolean
  readonly timeoutMs?: number
}): Promise<any> {
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-electron-bundle-'))
  try {
    const builtWorkerPath = path.resolve(process.cwd(), 'out/main/cline-sdk-worker.js')
    const workerPath = fs.existsSync(builtWorkerPath)
      ? builtWorkerPath
      : (() => {
          const out = path.join(bundleDir, 'cline-sdk-worker.cjs')
          buildSync({
            entryPoints: [path.resolve(process.cwd(), 'src/main/buildx/adapters/cline/cline-sdk-worker.ts')],
            outfile: out,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            packages: 'external'
          })
          return out
        })()

    let hardKillWorkerPath: string | undefined
    if (payload.includeHardKillWorker) {
      hardKillWorkerPath = path.join(bundleDir, 'hard-kill-worker.cjs')
      fs.writeFileSync(
        hardKillWorkerPath,
        `
const { spawn } = require('node:child_process');
const port = process.parentPort;
let sleeper;
port.on('message', (ev) => {
  const msg = ev && ev.data ? ev.data : ev;
  if (msg.type === 'prepare_attempt') {
    port.postMessage({ type: 'prepare_result', requestId: msg.requestId, ok: true, status: 'READY', modelId: msg.requestedModelId });
    setTimeout(() => process.exit(0), 20);
  } else if (msg.type === 'start_attempt') {
    sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'ignore' });
    port.postMessage({ type: 'attempt_started', attemptId: msg.attemptId, clineSessionId: 'hard-' + msg.attemptId, lockedModelId: msg.modelId, pid: process.pid });
    port.postMessage({ type: 'executor_event', event: { kind: 'TOOL_ACTIVITY', attemptId: msg.attemptId, timestamp: new Date().toISOString(), phase: 'RUNNING', status: 'RUNNING', message: 'descendant_pid:' + sleeper.pid, provenance: { executorId: 'cline-sdk', providerId: 'cline', modelId: msg.modelId } } });
  }
});
port.postMessage({ type: 'ready' });
        `,
        'utf8'
      )
    }

    const harnessOut = path.join(bundleDir, 'harness.cjs')
    buildSync({
      entryPoints: [path.resolve(process.cwd(), 'src/main/buildx/adapters/cline/cline-utility-e2e-harness.ts')],
      outfile: harnessOut,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      external: ['electron'],
      banner: {
        js: [
          `module.paths.unshift(${JSON.stringify(path.join(process.cwd(), 'node_modules'))});`,
          `try { const _e = require('electron'); if (_e && _e.dialog) { _e.dialog.showErrorBox = (t, c) => { process.stderr.write(String(t) + ': ' + String(c) + '\\n'); _e.app && _e.app.exit(1); }; } } catch {}`
        ].join('\n')
      }
    })

    const electronExe = req('electron') as string
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: path.join(process.cwd(), 'node_modules') }
    delete env.ELECTRON_RUN_AS_NODE

    return await new Promise((resolve, reject) => {
      const child = spawn(electronExe, [harnessOut], {
        cwd: process.cwd(),
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })

      let result: any = null
      let diagnostics = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        reject(new Error(`ELECTRON_HARNESS_TIMEOUT: ${diagnostics}`))
      }, payload.timeoutMs ?? 90_000)

      child.stdout?.on('data', (chunk) => { diagnostics += String(chunk) })
      child.stderr?.on('data', (chunk) => { diagnostics += String(chunk) })
      child.on('message', (msg) => { result = msg })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (!result) {
          reject(new Error(`ELECTRON_EXITED_WITHOUT_RESULT: code=${code}\n${diagnostics}`))
          return
        }
        resolve(result)
      })

      child.send({
        mode: payload.mode,
        workerPath,
        ...(hardKillWorkerPath ? { hardKillWorkerPath } : {})
      })
    })
  } finally {
    try { fs.rmSync(bundleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
}

describe('BuildX ClineSdkExecutorAdapter — Electron utilityProcess Real (Gates 1–4)', () => {
  it('Gates 1–3: inicializa ClineCore em utilityProcess, confina tools na worktree, trata cota 429, cancelamento e encerramento de descendentes sem inferência real', async () => {
    const res = await runInRealElectron({
      mode: 'gates',
      includeHardKillWorker: true,
      timeoutMs: 180_000
    })
    expect(res.error).toBeUndefined()
    expect(res.success).toBe(true)
    expect(res.probedModelId).toBe('free/local-mock-coder')
    expect(res.escapeBlocked).toBe(true)
    expect(res.isolatedStorageCleaned).toBe(true)
    expect(res.quotaReconciled).toBe(true)
    expect(res.hungUtilityCancelled).toBe(true)
    expect(res.descendantPidKilled).toBe(true)
    expect(res.unitAccepted).toBe(true)
    expect(res.billing?.classification).toBe('ZERO_COST_CONFIRMED')
    expect(res.billing?.upstreamCostUsd).toBe(810)
    expect(res.billing?.creditsUsed).toBe(0)
    expect(res.billing?.balanceDelta).toBe(0)
    expect(res.eventKinds).toContain('STARTED')
    expect(res.eventKinds).toContain('TOOL_ACTIVITY')
    expect(res.eventKinds).toContain('COMPLETED')
  }, 195_000)

  describe.runIf(process.env.BUILDX_CLINE_REAL_UNIT_E2E === '1')(
    'Gate 4: Execução unitária real única com modelo gratuito oficial e edição controlada',
    () => {
      it('executa uma unidade curta via UnitFlow MCP + ClineCore utilityProcess FREE, valida diff, prova CURRENT e aceita', async () => {
        const res = await runInRealElectron({
          mode: 'real-unit',
          timeoutMs: 150_000
        })
        expect(res.error).toBeUndefined()
        expect(res.success).toBe(true)
        expect(res.unitAcceptedStatus).toBe('ACCEPTED')
        expect(res.unitStatus).toBe('COMPLETED')
        expect(res.directedTestExitCode).toBe(0)
        expect(res.isolatedStorageCleaned).toBe(true)
        expect(res.termination?.confirmed).toBe(true)
        expect(res.gitDiff).toContain('+  return a + b')
        expect(res.billing?.classification).not.toBe('CHARGED')
        console.log('GATE4_REAL_UNIT_EVIDENCE=' + JSON.stringify(res))
      }, 160_000)
    }
  )
})
