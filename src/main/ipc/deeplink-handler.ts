/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar o handler IPC deeplink:get-pending que expõe a URL pendente ao renderer.
2. Limpar a URL pendente após retorná-la, garantindo consumo único.

Mapa de Relacionamentos do Script

1. deeplink-manager.ts
   - Tipo: Dependência Direta
   - Relação: Fornece getPendingDeepLink e clearPendingDeepLink.
   - Criticidade: Alta

2. preload.ts
   - Tipo: Dependência Inversa
   - Relação: Invoca o canal deeplink:get-pending exposto por este handler.
   - Criticidade: Alta

3. renderer (App.tsx)
   - Tipo: Fluxo de Dados
   - Relação: Consome a URL pendente via getPendingDeepLink no mount.
   - Criticidade: Alta

Invariantes do Script

1. O handler nunca lança — se não houver URL pendente, retorna null.
2. A URL pendente é limpa imediatamente após ser retornada, impedindo re-consumo.
3. O registro do handler ocorre uma única vez no ciclo de vida do app.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain } from 'electron'
import { getPendingDeepLink, clearPendingDeepLink } from '../core/deeplink-manager'

export function registerDeepLinkHandlers(): void {
  ipcMain.handle('deeplink:get-pending', () => {
    const url = getPendingDeepLink()
    console.log('[DL][hdl-get]', JSON.stringify(url))
    clearPendingDeepLink()
    return url
  })
}