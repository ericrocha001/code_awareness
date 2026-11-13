import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { AcademyPluginTask } from './academy-plugin-worker'
import type { AcademyBuildProjection } from '../../../shared/types/academy-publication-types'
import { AcademyError } from '../academy-package'
import type { AcademyGeminiExportReceipt } from '../../../shared/types/academy-types'

export interface AcademyPluginTaskResult {
  projection?: AcademyBuildProjection
  artifactPath?: string
  artifactHash?: string
  reused?: boolean
  phases: Record<string, number>
  receipt?: AcademyGeminiExportReceipt
}

export class AcademyPluginExecutor {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(readonly workerPath = join(__dirname, 'academy-plugin-worker.js')) {}

  hasWorker(): boolean {
    return existsSync(this.workerPath)
  }

  run(task: AcademyPluginTask, phase?: (name: string, durationMs: number) => void): Promise<AcademyPluginTaskResult> {
    const result = this.tail.then(() => this.execute(task, phase))
    this.tail = result.catch(() => {})
    return result
  }

  private execute(task: AcademyPluginTask, phase?: (name: string, durationMs: number) => void): Promise<AcademyPluginTaskResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, { workerData: task, resourceLimits: { maxOldGenerationSizeMb: 256 } })
      let completed = false
      const timer = setTimeout(() => finish(new AcademyError('ACADEMY_PACKAGE_OPERATION_TIMEOUT')), 120000)
      const finish = (error?: Error, result?: AcademyPluginTaskResult) => {
        if (completed) return
        completed = true; clearTimeout(timer)
        void worker.terminate()
        if (error) reject(error); else resolve(result!)
      }
      worker.on('message', message => {
        if (message.phase) phase?.(message.phase, message.durationMs)
        else if (message.error) finish(new AcademyError(message.error.code, message.error.message, message.error.details))
        else if (message.result) finish(undefined, message.result)
      })
      worker.once('error', error => finish(error))
      worker.once('exit', code => { if (!completed) finish(new AcademyError('ACADEMY_PACKAGE_WORKER_EXITED', `Worker exited ${code}`)) })
    })
  }
}
