/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Declarar os tipos puros e contratos estruturais do protocolo Code Dash compartilhados entre processos.

Mapa de Relacionamentos do Script

1. src/shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Reexporta as interfaces e uniões literais do protocolo Code Dash para o projeto.
   - Criticidade: Alta

2. src/shared/utils/dash-protocol.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos DashRepresentation e DashRequest para guardas e utilitários.
   - Criticidade: Alta

Invariantes do Script

1. Conter estritamente declarações de tipo e interfaces TypeScript sem lógica executável, constantes ou efeitos colaterais.
2. O formato de saída em DashRequest é estritamente fixado na união literal 'xml'.

--- FIM ARQUITETURA DO SCRIPT ---
*/

export type DashRepresentation = 'source' | 'compression'

export interface DashItem {
  path: string
  representation: DashRepresentation
}

export interface DashRequest {
  protocol: string
  output: {
    format: 'xml'
    name?: string
  }
  items: DashItem[]
}

export type DashFailureReason =
  | 'invalid_json'
  | 'unknown_protocol'
  | 'invalid_format'
  | 'empty_items'
  | 'invalid_representation'
  | 'invalid_path'
  | 'path_traversal'
  | 'absolute_path'
  | 'unknown_field'
  | 'duplicate_item'
  | 'not_found'
  | 'ambiguous'

export type DashResolutionStatus = 'resolved' | 'not_found' | 'ambiguous'

export interface DashResolutionFailure {
  index: number
  path: string
  reason: DashFailureReason
}

export interface DashResolutionReport {
  valid: boolean
  request: DashRequest | null
  failures: DashResolutionFailure[]
}

export interface DashPlannedItem {
  index: number
  path: string
  representation: DashRepresentation
  profile?: string
}

export interface DashPlanMetadata {
  requestedCount: number
  resolvedCount: number
  failedCount: number
}

export interface DashContextPlan {
  metadata: DashPlanMetadata
  plannedItems: DashPlannedItem[]
  failures: DashResolutionFailure[]
}

