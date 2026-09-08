import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { cleanupTempRepo, createTempRepo } from './test-helpers'

export interface CodeMapSystemFixture {
  repoPath: string
  write(relativePath: string, content: string): void
  writeBinary(relativePath: string, content: Buffer): void
  cleanup(): Promise<void>
}

export interface EventuallyOptions {
  description: string
  timeoutMs?: number
  intervalMs?: number
}

const INITIAL_FILES: Record<string, string> = {
  'src/core/BaseService.ts': [
    'export class BaseService {',
    '  label(): string { return "base-v1" }',
    '}',
    ''
  ].join('\n'),
  'src/core/AdminService.ts': 'export class AdminService {}\n',
  'src/core/UserService.ts': [
    'import { BaseService } from "./BaseService"',
    'export class UserService extends BaseService {',
    '  getLabel(): string { return "user-v1" }',
    '}',
    ''
  ].join('\n'),
  'src/renderer/App.tsx': [
    'import { UserService } from "../core/UserService"',
    'import "./styles.css"',
    'export function App() { return <main>{new UserService().getLabel()}</main> }',
    ''
  ].join('\n'),
  'src/renderer/helper.js': 'export function helper() { return "helper" }\n',
  'src/renderer/module.mjs': 'import { helper } from "./helper.js"\nexport const value = helper()\n',
  'src/renderer/legacy.cjs': 'const helper = require("./helper")\nexports.run = () => helper()\nmodule.exports.ready = true\n',
  'src/renderer/Widget.jsx': [
    'import { helper } from "./helper"',
    'export function Widget() { return <span>{helper()}</span> }',
    ''
  ].join('\n'),
  'src/renderer/styles.css': '@import "./theme.css";\n.app { color: red; }\n',
  'src/renderer/theme.css': ':root { --accent: red; }\n',
  'src/shared/types.ts': [
    'export interface User<T = string> { id: T }',
    'export function parse(value: string): string;',
    'export function parse(value: number): string;',
    'export function parse(value: string | number): string { return String(value) }',
    ''
  ].join('\n')
}

function writeFixtureFile(repoPath: string, relativePath: string, content: string): void {
  const fullPath = join(repoPath, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf8')
}

export function createCodeMapSystemFixture(): CodeMapSystemFixture {
  const repoPath = createTempRepo()
  for (const [relativePath, content] of Object.entries(INITIAL_FILES)) {
    writeFixtureFile(repoPath, relativePath, content)
  }

  return {
    repoPath,
    write: (relativePath, content) => writeFixtureFile(repoPath, relativePath, content),
    writeBinary: (relativePath, content) => {
      const fullPath = join(repoPath, relativePath)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content)
    },
    cleanup: () => cleanupTempRepo(repoPath)
  }
}

export function createLargeCodeMapFixture(fileCount: number): CodeMapSystemFixture {
  const repoPath = createTempRepo()
  for (let i = 0; i < fileCount; i++) {
    const group = Math.floor(i / 10)
    writeFixtureFile(
      repoPath,
      `src/group${group}/module${i}.ts`,
      `export class Module${i} {\n  run(): number { return ${i} }\n}\n`
    )
  }
  return {
    repoPath,
    write: (relativePath, content) => writeFixtureFile(repoPath, relativePath, content),
    writeBinary: (relativePath, content) => {
      const fullPath = join(repoPath, relativePath)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content)
    },
    cleanup: () => cleanupTempRepo(repoPath)
  }
}

export async function eventually<T>(
  condition: () => T | Promise<T>,
  options: EventuallyOptions
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      const result = await condition()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }

  const suffix = lastError instanceof Error ? ` Last observation: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${options.description}.${suffix}`)
}
