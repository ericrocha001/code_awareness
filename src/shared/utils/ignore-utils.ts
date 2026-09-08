/*
-T ---
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
