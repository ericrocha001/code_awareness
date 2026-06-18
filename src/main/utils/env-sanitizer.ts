// Responsabilidades do Script
//
// 1. Normalizar a variável PATH no Windows para garantir que caminhos globais de pacotes NPM/Yarn/PNPM sejam encontrados.

import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Normaliza a variável de ambiente PATH no Windows,
 * adicionando caminhos globais de pacotes NPM, Yarn e PNPM quando necessário.
 * Isso resolve problemas de detecção de comandos externos quando o aplicativo
 * é empacotado/compilado e o PATH do sistema não inclui esses diretórios.
 */
export function sanitizeEnvironment(): void {
  if (process.platform !== 'win32') {
    return
  }

  // Localizar a chave do PATH de forma case-insensitive
  let pathKey: string | undefined
  let currentPath: string | undefined

  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === 'path') {
      pathKey = key
      currentPath = process.env[key]
      break
    }
  }

  if (!pathKey || !currentPath) {
    console.log('[EnvSanitizer] PATH não encontrado no ambiente.')
    return
  }

  const appData = process.env.APPDATA
  if (!appData) {
    console.log('[EnvSanitizer] APPDATA não encontrado, pulando saneamento.')
    return
  }

  const pathsToAdd: string[] = []

  // Verificar NPM global bin
  const npmPath = join(appData, 'npm')
  if (existsSync(npmPath)) {
    const npmBin = join(npmPath, 'bin')
    if (!currentPath.toLowerCase().includes(npmBin.toLowerCase())) {
      pathsToAdd.push(npmBin)
      console.log(`[EnvSanitizer] Adicionando ao PATH: ${npmBin}`)
    }
  }

  // Verificar Yarn global bin
  const yarnPath = join(appData, 'yarn', 'bin')
  if (existsSync(join(appData, 'yarn')) && existsSync(yarnPath)) {
    if (!currentPath.toLowerCase().includes(yarnPath.toLowerCase())) {
      pathsToAdd.push(yarnPath)
      console.log(`[EnvSanitizer] Adicionando ao PATH: ${yarnPath}`)
    }
  }

  // Verificar PNPM global bin
  const pnpmPath = join(appData, 'pnpm')
  if (existsSync(pnpmPath)) {
    if (!currentPath.toLowerCase().includes(pnpmPath.toLowerCase())) {
      pathsToAdd.push(pnpmPath)
      console.log(`[EnvSanitizer] Adicionando ao PATH: ${pnpmPath}`)
    }
  }

  if (pathsToAdd.length > 0) {
    const newPath = currentPath + ';' + pathsToAdd.join(';')
    process.env[pathKey] = newPath
    console.log(`[EnvSanitizer] PATH atualizado com sucesso.`)
  } else {
    console.log(`[EnvSanitizer] Nenhum caminho adicional necessário.`)
  }
}