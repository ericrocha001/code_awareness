/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Fornecer funções puras e compartilhadas para normalização e manipulação de padrões de ignore.
2. Centralizar regras de formato de extensões/padrões para evitar duplicação e inconsistências.

Mapa de Relacionamentos do Script

1. CodeCompressionView.tsx
   - Tipo: Contrato / Interface
   - Relação: Consome normalizeIgnorePattern para garantir formato *.ext.
   - Criticidade: Alta

2. CodeSourceView.tsx
   - Tipo: Contrato / Interface
   - Relação: Consome normalizeIgnorePattern para garantir formato *.ext.
   - Criticidade: Alta

Invariantes do Script

1. Todo padrão de extensão persistente deve ser normalizado para o formato *.ext.
2. A normalização nunca deve remover o asterisco ou o ponto do formato final esperado.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/**
 * Normaliza uma extensão ou padrão de ignore para o formato canônico *.ext.
 *
 * Regras:
 * - Se já começar com *. preserva.
 * - Se começar com *, troca para *.
 * - Se começar com ., preserva o ponto e garante asterisco.
 * - Caso contrário, prefixa com *.
 *
 * Exemplos:
 * - "css" -> "*.css"
 * - ".css" -> "*.css"
 * - "*.css" -> "*.css"
 * - "*css" -> "*.css"
 */
export const normalizeIgnorePattern = (ext: string): string => {
  const trimmed = ext.trim()
  if (!trimmed) return '*'

  if (trimmed.startsWith('*.')) return trimmed

  const withoutLeadingStars = trimmed.replace(/^\*+/, '')
  const withoutLeadingDots = withoutLeadingStars.replace(/^\.+/, '')
  const core = withoutLeadingDots || withoutLeadingStars || trimmed.replace(/^\*/, '')

  return `*.${core}`
}
