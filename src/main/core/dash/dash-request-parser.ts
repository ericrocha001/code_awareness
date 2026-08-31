/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Extrair e deserializar payloads JSON brutos ou encapsulados em markdown code fences a partir de texto de entrada.

Mapa de Relacionamentos do Script

1. src/main/core/dash/dash-request-validator.ts
   - Tipo: Fluxo de Dados
   - Relação: Fornece o objeto desconhecido (unknown) para validação estrutural estrita.
   - Criticidade: Alta

Invariantes do Script

1. Operar como função pura sem dependências de I/O, sistema de arquivos ou estado mutável externo.
2. Nunca validar schema, versão ou regras de negócio do payload, restringindo-se à extração e parsing sintático de JSON.
3. Em caso de múltiplos blocos de código markdown, selecionar o primeiro bloco contendo JSON sintaticamente válido.

--- FIM ARQUITETURA DO SCRIPT ---
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
