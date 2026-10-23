import { expect, it, vi } from 'vitest'
import { TagService } from './tag-service'
const { settings } = vi.hoisted(() => ({ settings: {} as any }))
vi.mock('./settings-service', () => ({ settingsService: { loadSettings: () => settings, saveSettings: (next: object) => Object.assign(settings, next) } }))
it('preserves legacy path-based catalog and file IDs consumed by Code Source/Compression', () => {
  const legacy = new TagService()
  const tag = legacy.upsertTag('/legacy-A', { id: 'legacy-id', name: 'Legacy scripts', color: '#112233' })
  legacy.setFileTag('/legacy-A', 'src/file.ts', tag.id)
  expect(legacy.getTags('/legacy-A')).toEqual([tag])
  expect(legacy.getFileTags('/legacy-A')).toEqual({ 'src/file.ts': ['legacy-id'] })
  expect(legacy.getTags('/legacy-B')).toEqual([])
  expect(legacy.getFileTags('/legacy-B')).toEqual({})
  legacy.removeFileTag('/legacy-A', 'src/file.ts', tag.id)
  expect(legacy.getFileTags('/legacy-A')['src/file.ts']).toEqual([])
  legacy.deleteTag('/legacy-A', tag.id)
  expect(legacy.getTags('/legacy-A')).toEqual([])
})
