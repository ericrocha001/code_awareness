/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Centralizar as constantes de tempo do autosave e exibição de selo do editor de implementações.

Mapa de Relacionamentos do Script

1. ../components/CodeJourneyView/hooks/useJourneyEditor.ts
   - Tipo: Dependência Inversa
   - Relação: Importa AUTOSAVE_DEBOUNCE_MS e SAVED_STATUS_DISPLAY_MS.
   - Criticidade: Média

Invariantes do Script

1. As constantes devem ser exportadas como números inteiros de milissegundos.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/** Tempo de pausa (debounce) em milissegundos antes de disparar o salvamento automático das alterações de texto. */
export const AUTOSAVE_DEBOUNCE_MS = 700

/** Tempo de permanência em milissegundos da indicação visual "Salvo ✓" no selo de status. */
export const SAVED_STATUS_DISPLAY_MS = 1500
