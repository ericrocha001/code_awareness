/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Construir a string grid-template-columns da FileView a partir de overrides de largura por coluna sem impor limites mínimos artificiais.
2. Sanitizar larguras persistidas (unknown) em overrides seguros para o builder.

Mapa de Relacionamentos do Script

1. ../FileCollection/FileView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome buildFileViewTemplate/sanitizeColumnWidths para header e rows compartilharem o mesmo template.
   - Criticidade: Alta

2. ../../../hooks/useProjectPreferences.ts
   - Tipo: Dependência Inversa
   - Relação: Usa FileViewColumnKey na assinatura de updateFileViewColumnWidths.
   - Criticidade: Média

Invariantes do Script

1. Função pura: sem React, sem DOM — identidade header↔rows por construção (uma única string consumida pelos dois).
2. O default de buildFileViewTemplate() é byte-idêntico ao template declarado em FileView.css (.fv-header); o teste fileViewColumns.test.ts congela essa identidade.
3. Sem restrições mínimas artificiais de redimensionamento (mínimo 0px); números finitos não-negativos são preservados livremente.

--- FIM ARQUITETURA DO SCRIPT ---
*/

export type FileViewColumnKey = 'toggle' | 'identity' | 'path' | 'tags' | 'tokens'

export const FILE_VIEW_RESIZABLE_COLUMNS: FileViewColumnKey[] = [
  'toggle',
  'identity',
  'path',
  'tags',
  'tokens'
]

/** Larguras mínimas por coluna redimensionável (px) — sem travas mínimas artificiais. */
export const FILE_VIEW_COLUMN_MIN: Record<FileViewColumnKey, number> = {
  toggle: 0,
  identity: 0,
  path: 0,
  tags: 0,
  tokens: 0
}

/** Teto máximo de segurança (px). */
export const FILE_VIEW_COLUMN_MAX = 10000

/** Tracks default por coluna — refletem o template canônico do FileView.css. */
const DEFAULT_TRACKS: Record<FileViewColumnKey, string> = {
  toggle: '48px',
  identity: 'minmax(180px, 1.2fr)',
  path: 'minmax(120px, 1fr)',
  tags: 'minmax(200px, 2fr)',
  tokens: '120px'
}

/**
 * Template default — deve ser byte-idêntico à declaração de .fv-header em
 * FileView.css (identidade congelada por fileViewColumns.test.ts e R-B3.1).
 * Sprint 4: coluna 1 (toggle) = 48px — respiro à direita do ToggleSwitch.
 * Sprint 8: coluna 5 (tokens) = 120px fixos — a coluna de ações foi removida do
 * grid; o botão de ações agora é absoluto no final da row (.fr-action-btn).
 */
export const FILE_VIEW_DEFAULT_TEMPLATE =
  '48px minmax(180px, 1.2fr) minmax(120px, 1fr) minmax(200px, 2fr) 120px'

const clampWidth = (value: number, key: FileViewColumnKey): number =>
  Math.min(Math.max(Math.round(value), FILE_VIEW_COLUMN_MIN[key]), FILE_VIEW_COLUMN_MAX)

/**
 * Constrói o grid-template-columns da FileView. Colunas sem override válido
 * mantêm o track default (minmax/fixo); colunas com override numérico viram px.
 * Todas as 5 colunas são mapeadas — nenhum prefixo/sufixo fixo (Sprint 4/8).
 */
export const buildFileViewTemplate = (
  overrides?: Partial<Record<FileViewColumnKey, number>>
): string => {
  const hasOverride =
    overrides &&
    FILE_VIEW_RESIZABLE_COLUMNS.some((key) => {
      const raw = overrides[key]
      return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    })

  if (!hasOverride) return FILE_VIEW_DEFAULT_TEMPLATE

  const tracks = FILE_VIEW_RESIZABLE_COLUMNS.map((key) => {
    const raw = overrides?.[key]
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
      ? `${clampWidth(raw, key)}px`
      : DEFAULT_TRACKS[key]
  })

  return tracks.join(' ')
}

/**
 * Valida dados desconhecidos (settings.json possivelmente corrompido) em
 * overrides seguros. Aceita apenas números finitos não-negativos sob chaves conhecidas;
 * tudo o mais é descartado silenciosamente.
 */
export const sanitizeColumnWidths = (raw: unknown): Partial<Record<FileViewColumnKey, number>> => {
  if (typeof raw !== 'object' || raw === null) return {}

  const result: Partial<Record<FileViewColumnKey, number>> = {}
  for (const key of FILE_VIEW_RESIZABLE_COLUMNS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      result[key] = clampWidth(value, key)
    }
  }
  return result
}
