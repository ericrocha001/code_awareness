// Responsabilidades do Script
//
// 1. Verificar se o Codefetch CLI está instalado no sistema.
// 2. Executar o Codefetch em um repositório, copiar o Markdown gerado para code_awareness/[nome].md e fazer a limpeza da pasta temporária codefetch/.
// 3. Garantir a existência do arquivo .codefetchignore com as exclusões padrão antes de cada execução do Codefetch.

import { spawn } from 'child_process'
import { join, basename } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
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
      const proc = spawn(cmd, ['--version'], { shell: process.platform === 'win32' })
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

  async cleanupTemp(repoPath: string): Promise<void> {
    const codefetchDir = join(repoPath, 'codefetch')
    if (existsSync(codefetchDir)) {
      rmSync(codefetchDir, { recursive: true, force: true })
      console.log(`[CodefetchAdapter] Limpeza da pasta codefetch/ em: ${repoPath}`)
    }
  }

  private async ensureIgnoreFile(repoPath: string): Promise<void> {
    const ignorePath = join(repoPath, '.codefetchignore')
    if (!existsSync(ignorePath)) {
      const content = [
        '# Code Awareness Default Ignores',
        'AGENTS.md',
        '.codefetchignore',
        'code_awareness/',
        'node_modules/',
        'dist/',
        'out/'
      ].join('\n')
      await writeFile(ignorePath, content, 'utf-8')
      console.log(`[CodefetchAdapter] .codefetchignore criado em: ${repoPath}`)
    }
  }

  async run(repoPath: string): Promise<CodefetchResult> {
    const repoName = basename(repoPath)
    const fileName = `${repoName}.md`
    const tempPath = join(repoPath, 'codefetch', fileName)
    const destPath = join(repoPath, 'code_awareness', fileName)

    // Limpa qualquer resquício da pasta codefetch/ antes de iniciar
    await this.cleanupTemp(repoPath)

    // Garante o arquivo de exclusões .codefetchignore
    await this.ensureIgnoreFile(repoPath)

    return new Promise((resolve) => {
      let stderr = ''

      // Salva apenas o nome do arquivo (sem barras) para evitar erro no Codefetch
      const proc = spawn(this.getCommand(), ['-o', fileName], {
        cwd: repoPath,
        shell: process.platform === 'win32'
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
          try {
            if (!existsSync(tempPath)) {
              resolve({
                success: false,
                error: `Arquivo temporário não encontrado em codefetch/${fileName}`
              })
              return
            }

            // Lê o conteúdo gerado pelo Codefetch
            const content = await readFile(tempPath, 'utf-8')

            // Cria a pasta code_awareness/ e copia o arquivo
            mkdirSync(join(repoPath, 'code_awareness'), { recursive: true })
            await writeFile(destPath, content, 'utf-8')

            // Limpa a pasta temporária codefetch/ (inclui resquícios antigos como codebase.md)
            rmSync(join(repoPath, 'codefetch'), { recursive: true, force: true })

            resolve({ success: true, markdown: content })
          } catch (err: any) {
            resolve({
              success: false,
              error: `Erro ao processar o arquivo gerado: ${err.message}`
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