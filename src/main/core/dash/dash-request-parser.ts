/*
-T ---
*/

export type DashParseResult =
  | { success: true; request: unknown }
  | { success: false; error: string }

export function parseDashRequest(input: unknown): DashParseResult {
  if (typeof input !== 'string') {
    return { success: false, error: 'Input must be a string' }
  }

  const trimmed = input.trim()
  if (!trimmed) {
    return { success: false, error: 'Input is empty' }
  }

  // 1. Tenta parsear diretamente caso seja JSON puro sem markdown fences
  try {
    const parsed = JSON.parse(trimmed)
    return { success: true, request: parsed }
  } catch {
    // Não é JSON puro válido, segue para busca em markdown fences
  }

  // 2. Extrai blocos de código (ex: ```json ... ``` ou ``` ... ```)
  const codeBlockRegex = /```(?:[a-zA-Z0-9_-]+)?\r?\n?([\s\S]*?)```/g
  const matches = [...trimmed.matchAll(codeBlockRegex)]

  if (matches.length > 0) {
    let lastError: string | null = null
    for (const match of matches) {
      const blockContent = match[1].trim()
      if (!blockContent) continue
      try {
        const parsed = JSON.parse(blockContent)
        return { success: true, request: parsed }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    return {
      success: false,
      error: lastError
        ? `Failed to parse JSON inside code fences: ${lastError}`
        : 'Code fences found but none contained valid JSON'
    }
  }

  return {
    success: false,
    error: 'No valid JSON found in input'
  }
}
