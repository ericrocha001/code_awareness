// Responsabilidades do Script
//
// 1. Verificar se o Codefetch CLI está instalado no sistema.
// 2. Executar o Codefetch em um repositório e ler o Markdown gerado a partir do arquivo codebase.md.

import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { CodefetchResult } from '../../shared/types'

const TIMEOUT_MS = 120_000

export class CodefetchAdapter {
  private getCommand(): string {
    return process.platform === 'win32' ? 'codefetch.cmd' : 'codefetch'
  }

  async checkInstallation(): Promise<boolean> {
    console.log(`[CodefetchAdapter] Verificando instalação na plataforma: ${process.platform}`)
    const cmd = this.getCommand()
    console.log(`[CodefetchAdapter] Comando a ser executado: ${cmd}`)
    console.log(`[CodefetchAdapter] PATH env: ${process.env.PATH}`)

    return new Promise((resolve) => {
      const proc = spawn(cmd, ['--version'], { shell: true })
      proc.on('close', (code) => {
        console.log(`[CodefetchAdapter] Verificação de instalação concluída com código: ${code}`)
        resolve(code === 0)
      })
      proc.on('error', (err) => {
        console.error(`[CodefetchAdapter] Erro ao verificar instalação: ${err.message}`, err)
        resolve(false)
      })
    })
  }

  async run(repoPath: string): Promise<CodefetchResult> {
    return new Promise((resolve) => {
      let stderr = ''

      const proc = spawn(this.getCommand(), [], {
        cwd: repoPath,
        shell: true
      })

      const timer = setTimeout(() => {
        proc.kill()
        resolve({ success: false, error: 'Repository analysis timed out' })
      }, TIMEOUT_MS)

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      proc.on('close', async (code) => {
        clearTimeout(timer)
        if (code === 0) {
          const outputPath = join(repoPath, 'codefetch', 'codebase.md')
          try {
            if (existsSync(outputPath)) {
              const content = await readFile(outputPath, 'utf-8')
              resolve({ success: true, markdown: content })
            } else {
              resolve({
                success: false,
                error: 'Arquivo codebase.md não encontrado no diretório do projeto em <repo>/codefetch/codebase.md'
              })
            }
          } catch (err: any) {
            resolve({
              success: false,
              error: `Erro ao ler o arquivo codebase.md: ${err.message}`
            })
          }
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
