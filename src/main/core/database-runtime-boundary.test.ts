/*
-T ---
*/

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

function findTestFiles(dir: string): string[] {
  const results: string[] = []
  const list = readdirSync(dir)
  for (const file of list) {
    const filePath = join(dir, file)
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      results.push(...findTestFiles(filePath))
    } else if (file.endsWith('.test.ts') && !file.endsWith('.e2e.test.ts') && file !== 'database-runtime-boundary.test.ts') {
      results.push(filePath)
    }
  }
  return results
}

describe('Database Runtime Boundary — Isolamento de Persistência', () => {
  it('descobre dinamicamente os testes de domínio e garante que nenhum importe SQLite nativo', () => {
    const srcDir = join(process.cwd(), 'src')
    const testFiles = findTestFiles(srcDir)

    // Proteção contra regressão silenciosa
    expect(testFiles.length).toBeGreaterThan(0)

    const forbiddenPatterns = [
      "from 'better-sqlite3'",
      'from "better-sqlite3"',
      "require('better-sqlite3')",
      'require("better-sqlite3")',
      "import('better-sqlite3')",
      'import("better-sqlite3")',
      "from './better-sqlite3",
      'from "./better-sqlite3',
      'from "../core/better-sqlite3',
      "from '../core/better-sqlite3",
      "require('./better-sqlite3",
      'require("./better-sqlite3',
      'require("../core/better-sqlite3',
      "require('../core/better-sqlite3",
      "from './repository-database",
      'from "./repository-database',
      "from '../core/repository-database",
      'from "../core/repository-database'
    ]

    const violations: string[] = []

    for (const testPath of testFiles) {
      const content = readFileSync(testPath, 'utf-8')
      const lines = content.split('\n')
      lines.forEach((line, index) => {
        const trimmed = line.trim()
        // Ignora comentários de arquitetura ou documentação
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return

        for (const pattern of forbiddenPatterns) {
          if (line.includes(pattern)) {
            violations.push(`${testPath}:${index + 1}: ${trimmed}`)
            break
          }
        }
      })
    }

    if (violations.length > 0) {
      const message = `Encontradas ${violations.length} violações de fronteira de persistência:\n` + violations.join('\n')
      expect(violations).toEqual([])
    }

    expect(violations).toEqual([])
  })
})
