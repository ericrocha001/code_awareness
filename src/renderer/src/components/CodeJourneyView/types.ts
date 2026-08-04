/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Centralizar os tipos de domínio do drawer de auditoria que são compartilhados entre mais de um componente.
2. Eliminar dependências circulares entre CheckpointDrawer e ChangesSection.
3. Centralizar o tipo de estado de UI do autosave (SaveStatus) usado por três componentes.

Mapa de Relacionamentos do Script

1. CheckpointDrawer.tsx
   - Tipo: Dependência Inversa
   - Relação: Importa FileListItem para declarar sua prop fileList.
   - Criticidade: Alta

2. ChangesSection.tsx
   - Tipo: Dependência Inversa
   - Relação: Importa FileListItem para tipar a prop fileList sem depender do drawer.
   - Criticidade: Alta

3. CodeJourneyView.tsx
   - Tipo: Dependência Inversa
   - Relação: Importa SaveStatus para tipar o estado do autosave.
   - Criticidade: Alta

4. DocumentationSection.tsx
   - Tipo: Dependência Inversa
   - Relação: Importa SaveStatus para tipar a prop saveStatus.
   - Criticidade: Alta

Invariantes do Script

1. Este arquivo não importa nenhum outro módulo local — é um módulo folha de tipos puros.
2. Nenhuma lógica de negócio ou side effect é introduzido aqui.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/** Representa um arquivo alterado dentro de uma implementação (checkpoint). */
export interface FileListItem {
  path: string
  name: string
  changeType: 'modified' | 'added' | 'deleted'
}

/** Estado de UI do autosave na documentação. */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'