/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Normalizar caminhos de projeto para comparação robusta entre plataformas (Windows vs Unix).
2. Converter barras invertidas em barras e remover a barra final.

Mapa de Relacionamentos do Script

1. CodeMapView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome normalizeProjectPath para comparar caminhos de eventos ao projeto ativo.
   - Criticidade: Alta

Invariantes do Script

1. A função é pura — recebe string e retorna string, sem side effects.
2. A normalização é determinística — mesma entrada sempre produz a mesma saída.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/** Normaliza caminho de projeto: barras invertidas → barras e remove a barra final. */
export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/$/, '')
}