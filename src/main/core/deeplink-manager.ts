/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Guardar a URL de deep link pendente de consumo pelo renderer.
2. Expor a URL pendente e permitir limpá-la após o consumo.
3. Emitir a URL de deep link recebida para o renderer via webContents.

Mapa de Relacionamentos do Script

1. deeplink-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Consome getPendingDeepLink e clearPendingDeepLink para expor via IPC.
   - Criticidade: Alta

2. main.ts
   - Tipo: Dependência Inversa
   - Relação: Usa setPendingDeepLink e emitDeepLinkToRenderer na captura de deep link.
   - Criticidade: Alta

3. renderer (App.tsx)
   - Tipo: Fluxo de Dados
   - Relação: Recebe a URL pendente via IPC e o evento deeplink:received.
   - Criticidade: Alta

Invariantes do Script

1. A URL pendente é consumida exatamente uma vez — o handler IPC limpa após retornar.
2. A emissão para o renderer só ocorre quando a janela principal existe e não está destruída.
3. O módulo não acessa DOM, IPC ou renderer diretamente — apenas recebe/chama BrowserWindow e funções puras.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { BrowserWindow } from 'electron'

let pendingDeepLink: string | null = null

export function setPendingDeepLink(url: string): void {
  console.log('[DL][mgr-set]', JSON.stringify(url))
  pendingDeepLink = url
}

export function getPendingDeepLink(): string | null {
  return pendingDeepLink
}

export function clearPendingDeepLink(): void {
  pendingDeepLink = null
}

export function emitDeepLinkToRenderer(mainWindow: BrowserWindow, url: string): void {
  console.log('[DL][mgr-emit]', JSON.stringify(url), 'windowAlive=', !!(mainWindow && !mainWindow.isDestroyed()))
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deeplink:received', url)
  }
}