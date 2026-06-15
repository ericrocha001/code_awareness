// Responsabilidades do Script
//
// 1. Verificar se o Codefetch CLI está instalado no sistema.
// 2. Executar o Codefetch em um repositório e capturar o Markdown gerado.

import { spawn } from 'child_process'
import { CodefetchResult } from '../../shared/types'

const TIMEOUT_MS = 120_000

export class CodefetchAdapter {
  async checkInstallation(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('codefetch', ['--version'], { shell: true })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }

  async run(repoPath: string): Promise<CodefetchResult> {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''

      const proc = spawn('codefetch', [], {
        cwd: repoPath,
        shell: true
      })

      const timer = setTimeout(() => {
        proc.kill()
        resolve({ success: false, error: 'Repository analysis timed out' })
      }, TIMEOUT_MS)

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && stdout.trim()) {
          resolve({ success: true, markdown: stdout })
        } else {
          resolve({
            success: false,
            error: stderr.trim() || 'Codefetch failed to analyze the repository'
          })
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        resolve({ success: false, error: `Could not run codefetch: ${err.message}` })
      })
    })
  }
}
