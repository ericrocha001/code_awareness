/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a conformidade estrutural, campos permitidos e regras de segurança de requisições Code Dash.

Mapa de Relacionamentos do Script

1. src/shared/types/dash-types.ts
   - Tipo: Contrato / Interface
   - Relação: Importa DashRequest, DashItem, DashRepresentation e DashFailureReason.
   - Criticidade: Alta

2. src/shared/utils/dash-protocol.ts
   - Tipo: Dependência Direta
   - Relação: Utiliza DASH_PROTOCOL_VERSION e isDashRepresentation para validação de versão e tipos.
   - Criticidade: Alta

Invariantes do Script

1. Operar puramente em memória sem realizar qualquer operação de I/O em disco ou rede.
2. Rejeitar estritamente qualquer campo desconhecido no payload raiz, no objeto output ou nos itens.
3. Bloquear qualquer caminho que contenha path traversal (..) ou que represente um caminho absoluto.
4. Garantir que apenas requisições em conformidade total com o contrato code-dash/v1 sejam aprovadas.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type {
  DashFailureReason,
  DashItem,
  DashRequest
} from '../../../shared/types/dash-types'
import {
  DASH_PROTOCOL_VERSION,
  isDashRepresentation
} from '../../../shared/utils/dash-protocol'

export type DashValidationResult =
  | { success: true; request: DashRequest }
  | { success: false; error: string; reason?: DashFailureReason }

function hasUnknownKeys(
  obj: Record<string, unknown>,
  allowedKeys: readonly string[]
): string | null {
  const keys = Object.keys(obj)
  const unknownKey = keys.find((key) => !allowedKeys.includes(key))
  return unknownKey || null
}

function isAbsolutePath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\')) {
    return true
  }
  if (/^[a-zA-Z]:/.test(p)) {
    return true
  }
  return false
}

function hasPathTraversal(p: string): boolean {
  return p.includes('..')
}

export function validateDashRequest(input: unknown): DashValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      success: false,
      error: 'Request must be a non-null object',
      reason: 'invalid_json'
    }
  }

  const record = input as Record<string, unknown>

  // 1. Validação de campos desconhecidos no top-level
  const allowedTopKeys = ['protocol', 'output', 'items'] as const
  const unknownTopKey = hasUnknownKeys(record, allowedTopKeys)
  if (unknownTopKey) {
    return {
      success: false,
      error: `Unknown field in request root: "${unknownTopKey}"`,
      reason: 'unknown_field'
    }
  }

  // 2. Validação da versão do protocolo
  if (
    typeof record.protocol !== 'string' ||
    record.protocol !== DASH_PROTOCOL_VERSION
  ) {
    return {
      success: false,
      error: `Invalid or missing protocol. Expected "${DASH_PROTOCOL_VERSION}", received "${String(record.protocol)}"`,
      reason: 'unknown_protocol'
    }
  }

  // 3. Validação do bloco de output
  if (
    typeof record.output !== 'object' ||
    record.output === null ||
    Array.isArray(record.output)
  ) {
    return {
      success: false,
      error: 'Field "output" must be a non-null object',
      reason: 'invalid_format'
    }
  }

  const outputRecord = record.output as Record<string, unknown>
  const allowedOutputKeys = ['format', 'name'] as const
  const unknownOutputKey = hasUnknownKeys(outputRecord, allowedOutputKeys)
  if (unknownOutputKey) {
    return {
      success: false,
      error: `Unknown field in "output": "${unknownOutputKey}"`,
      reason: 'unknown_field'
    }
  }

  if (outputRecord.format !== 'xml') {
    return {
      success: false,
      error: `Invalid output format. Expected "xml", received "${String(outputRecord.format)}"`,
      reason: 'invalid_format'
    }
  }

  if (
    outputRecord.name !== undefined &&
    typeof outputRecord.name !== 'string'
  ) {
    return {
      success: false,
      error: 'Field "output.name" must be a string if provided',
      reason: 'invalid_format'
    }
  }

  // 4. Validação do array de itens
  if (!Array.isArray(record.items)) {
    return {
      success: false,
      error: 'Field "items" must be an array',
      reason: 'empty_items'
    }
  }

  if (record.items.length === 0) {
    return {
      success: false,
      error: 'Field "items" must contain at least one item',
      reason: 'empty_items'
    }
  }

  // 5. Validação individual de cada item e detecção de duplicatas
  const seenItems = new Set<string>()
  const allowedItemKeys = ['path', 'representation'] as const
  const validatedItems: DashItem[] = []

  for (let i = 0; i < record.items.length; i++) {
    const item = record.items[i]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return {
        success: false,
        error: `Item at index ${i} must be a non-null object`,
        reason: 'invalid_path'
      }
    }

    const itemRecord = item as Record<string, unknown>
    const unknownItemKey = hasUnknownKeys(itemRecord, allowedItemKeys)
    if (unknownItemKey) {
      return {
        success: false,
        error: `Unknown field in item at index ${i}: "${unknownItemKey}"`,
        reason: 'unknown_field'
      }
    }

    if (
      typeof itemRecord.path !== 'string' ||
      itemRecord.path.trim().length === 0
    ) {
      return {
        success: false,
        error: `Item at index ${i} must have a non-empty "path" string`,
        reason: 'invalid_path'
      }
    }

    const rawPath = itemRecord.path.trim()

    if (isAbsolutePath(rawPath)) {
      return {
        success: false,
        error: `Item at index ${i} has an absolute path: "${rawPath}". Only relative paths are allowed`,
        reason: 'absolute_path'
      }
    }

    if (hasPathTraversal(rawPath)) {
      return {
        success: false,
        error: `Item at index ${i} contains path traversal (".."): "${rawPath}"`,
        reason: 'path_traversal'
      }
    }

    if (!isDashRepresentation(itemRecord.representation)) {
      return {
        success: false,
        error: `Item at index ${i} has invalid representation: "${String(itemRecord.representation)}". Supported: "source", "compression"`,
        reason: 'invalid_representation'
      }
    }

    const normalizedPath = rawPath.replace(/\\/g, '/')
    const itemKey = `${normalizedPath}::${itemRecord.representation}`
    if (seenItems.has(itemKey)) {
      return {
        success: false,
        error: `Duplicate item found at index ${i}: path "${rawPath}" with representation "${itemRecord.representation}"`,
        reason: 'duplicate_item'
      }
    }
    seenItems.add(itemKey)

    validatedItems.push({
      path: rawPath,
      representation: itemRecord.representation
    })
  }

  return {
    success: true,
    request: {
      protocol: DASH_PROTOCOL_VERSION,
      output: {
        format: 'xml',
        ...(outputRecord.name !== undefined
          ? { name: outputRecord.name as string }
          : {})
      },
      items: validatedItems
    }
  }
}
