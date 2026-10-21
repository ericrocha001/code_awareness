import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { registerContinuumHandlers } from './continuum-handler'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'

const { handlers, save, writeText, writeImage, createImage } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), save: vi.fn(), writeText: vi.fn(), writeImage: vi.fn(), createImage: vi.fn((_data: Buffer) => ({ isEmpty: () => false })) }))
vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' }, ipcMain: { handle: (key: string, handler: Function) => handlers.set(key, handler) },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] }, dialog: { showSaveDialog: save },
  clipboard: { writeText, writeImage }, nativeImage: { createFromBuffer: createImage }
}))
let folder: string, current: string, revision: number
const rawMarkdown = '\uFEFF---\r\nname: Literal\r\ndescription: Export\r\nkind: DOCUMENT\r\n---\r\n# ç 日本語 🚀\r\n\r\n| a | b |\r\n|---|---|\r\n```ts\r\n${literal}\r\n```\r\n'
let kind: string, name: string
const getVisual = vi.fn()
const get = vi.fn(() => ({ artifactId: 'one', revision, rawMarkdown, metadata: { kind, name } }))
const service = { get, getVisual }
const sender = { id: 1, isDestroyed: () => false }
const invoke = (intent = 'copy', repositoryId = 'A', artifactId = 'one', extra = {}) => handlers.get('continuum:export')!({ sender }, { repositoryId, artifactId, intent, ...extra })
beforeEach(() => {
  vi.clearAllMocks(); mkdirSync('scratch', { recursive: true }); folder = mkdtempSync(join(process.cwd(), 'scratch', 'continuum-export-')); current = 'A'; revision = 1; kind = 'DOCUMENT'; name = '../CON: Test?'
  get.mockImplementation(() => ({ artifactId: 'one', revision, rawMarkdown, metadata: { kind, name } }))
  registerContinuumHandlers({ getActiveSession: () => ({ repositoryId: current }), getActiveService: () => service, onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

it('copies literal Markdown and saves the same UTF-8/BOM/CRLF bytes with native destination and sanitized suggestion', async () => {
  await expect(invoke()).resolves.toMatchObject({ outcome: 'copied' })
  expect(writeText).toHaveBeenCalledWith(rawMarkdown)
  expect(getVisual).not.toHaveBeenCalled()
  const filePath = join(folder, 'literal.md')
  save.mockResolvedValue({ filePath, canceled: false })
  await expect(invoke('save', 'A', 'one', { filePath: '/ignored/injection.md', rawMarkdown: 'ignored' })).resolves.toMatchObject({ outcome: 'saved' })
  expect(readFileSync(filePath)).toEqual(Buffer.from(rawMarkdown, 'utf8'))
  const options = save.mock.calls[0][0]
  expect(options.defaultPath).toBe(join('/downloads', '_CON_ Test_.md'))
  expect(options.properties).toContain('showOverwriteConfirmation')
  expect(readdirSync(folder)).toEqual(['literal.md'])
})

it('preserves WebP source bytes/hash and decodes only for a lossless PNG clipboard representation with alpha', async () => {
  kind = 'VISUAL_REFERENCE'
  const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0])
  const data = await sharp(pixels, { raw: { width: 3, height: 1, channels: 4 } }).webp({ lossless: true }).toBuffer()
  getVisual.mockReturnValue({ data })
  const source = Buffer.from(data)
  await invoke()
  const png = createImage.mock.calls[0][0] as unknown as Buffer
  expect(png.subarray(1, 4).toString()).toBe('PNG')
  const decoded = (input: Buffer) => sharp(input).ensureAlpha().raw().toBuffer()
  expect(await decoded(png)).toEqual(await decoded(source))
  expect(writeImage).toHaveBeenCalledTimes(1)
  expect(writeText).not.toHaveBeenCalled()
  save.mockResolvedValue({ filePath: join(folder, 'original.webp'), canceled: false })
  await invoke('save')
  const saved = readFileSync(join(folder, 'original.webp'))
  expect(saved.length).toBe(source.length)
  expect(createHash('sha256').update(saved).digest('hex')).toBe(createHash('sha256').update(source).digest('hex'))
  expect(data).toEqual(source)
})

it('refuses wrong repository/intent/selection, missing content and integrity errors before any native side effect', async () => {
  await expect(invoke('copy', 'B')).rejects.toThrow('REPOSITORY_UNAVAILABLE')
  await expect(invoke('other')).rejects.toThrow('INVALID_ARGUMENT')
  await expect(invoke('copy', 'A', '')).rejects.toThrow('INVALID_ARGUMENT')
  get.mockReturnValueOnce(null as any)
  await expect(invoke()).rejects.toThrow('ARTIFACT_NOT_FOUND')
  kind = 'VISUAL_REFERENCE'; getVisual.mockImplementationOnce(() => { throw new Error('VISUAL_INTEGRITY_ERROR') })
  await expect(invoke('save')).rejects.toThrow('VISUAL_INTEGRITY_ERROR')
  expect(save).not.toHaveBeenCalled(); expect(writeText).not.toHaveBeenCalled(); expect(writeImage).not.toHaveBeenCalled()
  expect(readdirSync(folder)).toEqual([])
})

it('cancels without writing and rejects context/revision changes while a save dialog is pending, locking duplicates', async () => {
  save.mockResolvedValueOnce({ canceled: true })
  expect(await invoke('save')).toMatchObject({ outcome: 'cancelled' })
  let finish!: (value: object) => void
  save.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = invoke('save')
  await expect(invoke()).rejects.toThrow('EXPORT_BUSY')
  current = 'B'; finish({ canceled: false, filePath: join(folder, 'stale.md') })
  await expect(pending).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
  current = 'A'
  const changed = invoke('save'); revision++; finish({ canceled: false, filePath: join(folder, 'stale.md') })
  await expect(changed).rejects.toThrow('ARTIFACT_CONTEXT_CHANGED')
  expect(readdirSync(folder)).toEqual([])
})

it('reports extension, permission and write/rename failures without leaving partial files or touching existing data', async () => {
  save.mockResolvedValueOnce({ canceled: false, filePath: join(folder, 'wrong.txt') })
  await expect(invoke('save')).rejects.toThrow('INVALID_EXPORT_EXTENSION')
  save.mockRejectedValueOnce(new Error('EACCES'))
  await expect(invoke('save')).rejects.toThrow('EACCES')
  save.mockResolvedValueOnce({ canceled: false, filePath: join(folder, 'absent', 'file.md') })
  await expect(invoke('save')).rejects.toThrow()
  expect(readdirSync(folder)).toEqual([])
  const original = join(folder, 'existing.md'); writeFileSync(original, 'existing')
  save.mockResolvedValueOnce({ canceled: true, filePath: original })
  await invoke('save')
  expect(readFileSync(original, 'utf8')).toBe('existing')
})

it('guards reserved filenames and keeps the required extension', async () => {
  name = 'NUL'
  save.mockResolvedValue({ canceled: true })
  await invoke('save')
  expect(save.mock.calls[0][0].defaultPath).toBe(join('/downloads', '_NUL.md'))
})
