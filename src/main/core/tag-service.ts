/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar o CRUD de tags por repositório.
2. Persistir alterações no settings.json com validação mínima de dados.
3. Garantir unicidade de ID para novas tags.

Mapa de Relacionamentos do Script

1. settings-service.ts
   - Tipo: Dependência Direta
   - Relação: Usa a instância singleton para ler/salvar configurações.
   - Criticidade: Alta

2. tag-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Expõe operações do serviço para o renderer via IPC.
   - Criticidade: Alta

3. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Define os tipos Tag e AppSettings.
   - Criticidade: Alta

Invariantes do Script

1. Nunca modificar o repoPath salvo em outras chaves durante uma operação.
2. Nunca retornar dados parcialmente escritos em caso de falha de escrita.
3. Nunca duplicar IDs dentro do mesmo repoPath.
4. O serviço não deve depender de código de UI.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { randomUUID } from 'crypto'
import { AppSettings, Tag } from '../../shared/types'
import { settingsService } from './settings-service'

export class TagService {
  getTags(repoPath: string): Tag[] {
    if (!repoPath || typeof repoPath !== 'string') return []
    const settings = settingsService.loadSettings()
    const tags = settings.tags?.[repoPath] ?? []
    return tags.map((tag) => ({ ...tag }))
  }

  upsertTag(repoPath: string, tag: Tag): Tag {
    if (!repoPath || typeof repoPath !== 'string') {
      throw new Error('repoPath inválido')
    }
    const sanitizedColor = /^#[0-9a-fA-F]{6}$/.test(tag.color) ? tag.color : '#7852ee'
    const id = tag.id && String(tag.id).trim().length > 0 ? tag.id : randomUUID()

    const settings = settingsService.loadSettings()
    const current = settings.tags?.[repoPath] ?? []
    const index = current.findIndex((item) => item.id === id)

    const base = {
      id,
      name: String(tag.name ?? '').trim() || 'Sem nome',
      color: sanitizedColor
    }

    let next: Tag[]
    if (index >= 0) {
      next = current.map((item, idx) => (idx === index ? { ...item, ...base } : item))
    } else {
      next = [...current, base]
    }

    settings.tags = {
      ...(settings.tags ?? {}),
      [repoPath]: next
    }
    settingsService.saveSettings(settings)
    return base
  }

  deleteTag(repoPath: string, tagId: string): void {
    if (!repoPath || typeof repoPath !== 'string') return
    if (!tagId || typeof tagId !== 'string') return
    const settings = settingsService.loadSettings()
    const current = settings.tags?.[repoPath] ?? []
    const next = current.filter((item) => item.id !== tagId)
    settings.tags = {
      ...(settings.tags ?? {}),
      [repoPath]: next
    }
    // Remove a tag de todos os arquivos associados
    const fileTags = settings.fileTags?.[repoPath]
    if (fileTags) {
      for (const relativePath of Object.keys(fileTags)) {
        fileTags[relativePath] = fileTags[relativePath].filter((id) => id !== tagId)
      }
      settings.fileTags = {
        ...(settings.fileTags ?? {}),
        [repoPath]: fileTags
      }
    }
    settingsService.saveSettings(settings)
  }

  // ─── Associação Arquivo ↔ Tag ──────────────────────────────────────────

  getFileTags(repoPath: string): Record<string, string[]> {
    if (!repoPath || typeof repoPath !== 'string') return {}
    const settings = settingsService.loadSettings()
    const fileTags = settings.fileTags?.[repoPath]
    if (!fileTags) return {}
    // Retorna cópia para evitar mutação externa
    const result: Record<string, string[]> = {}
    for (const key of Object.keys(fileTags)) {
      result[key] = [...fileTags[key]]
    }
    return result
  }

  setFileTag(repoPath: string, relativePath: string, tagId: string): void {
    if (!repoPath || typeof repoPath !== 'string') return
    if (!relativePath || typeof relativePath !== 'string') return
    if (!tagId || typeof tagId !== 'string') return
    const settings = settingsService.loadSettings()
    const fileTags = { ...(settings.fileTags?.[repoPath] ?? {}) }
    const current = fileTags[relativePath] ?? []
    if (!current.includes(tagId)) {
      fileTags[relativePath] = [...current, tagId]
    }
    settings.fileTags = {
      ...(settings.fileTags ?? {}),
      [repoPath]: fileTags
    }
    settingsService.saveSettings(settings)
  }

  removeFileTag(repoPath: string, relativePath: string, tagId: string): void {
    if (!repoPath || typeof repoPath !== 'string') return
    if (!relativePath || typeof relativePath !== 'string') return
    if (!tagId || typeof tagId !== 'string') return
    const settings = settingsService.loadSettings()
    const fileTags = { ...(settings.fileTags?.[repoPath] ?? {}) }
    const current = fileTags[relativePath] ?? []
    fileTags[relativePath] = current.filter((id) => id !== tagId)
    settings.fileTags = {
      ...(settings.fileTags ?? {}),
      [repoPath]: fileTags
    }
    settingsService.saveSettings(settings)
  }
}

export const tagService = new TagService()
