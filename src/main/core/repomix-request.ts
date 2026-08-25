/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir o contrato tipado (RepomixRequest) trocado entre o CompressionService e o RepomixAdapter.
2. Encapsular toda a informação necessária para uma operação de compressão: repositório, arquivos selecionados, perfil efetivo e formato de transporte.
3. Substituir a fragilidade da manipulação de `string[]` por um contrato explícito, type-safe e serializável.

Mapa de Relacionamentos do Script

1. compression-service.ts
   - Tipo: Dependência Inversa
   - Relação: Constrói e consome RepomixRequest via buildRepomixRequest (do builder) e o envia ao adapter.
   - Criticidade: Alta

2. repomix-adapter.ts
   - Tipo: Dependência Inversa
   - Relação: Recebe RepomixRequest em compressSingleFile e compressMultipleFiles para derivar os argumentos CLI.
   - Criticidade: Alta

3. repomix-arguments-builder.ts
   - Tipo: Dependência Inversa
   - Relação: buildRepomixRequest produz uma RepomixRequest (Contrato / Interface deste módulo).
   - Criticidade: Alta

4. effective-profile.ts
   - Tipo: Dependência Direta
   - Relação: Importa o tipo EffectiveProfile usado como representação mínima do perfil no contrato.
   - Criticidade: Alta

5. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Importa o tipo OutputFormat do transporte.
   - Criticidade: Média

Invariantes do Script

1. O contrato é imutável após criação (campos readonly).
2. O módulo não conhece cache, CLI, processo, Repomix nem montagem de documento — apenas o tipo.
3. O perfil transportado é o EffectiveProfile (representação semântica mínima), não o perfil armazenado cru.
4. selectedFiles são caminhos relativos ao repoPath; o contrato é serializável para logging/debugging.
*/

import type { EffectiveProfile } from './effective-profile'
import type { OutputFormat } from '../../shared/types'

/** Contrato tipado de uma operação de compressão entre Service e Adapter. */
export interface RepomixRequest {
  readonly repoPath: string
  readonly selectedFiles: string[]
  readonly profile: EffectiveProfile
  readonly outputFormat: OutputFormat
}