/*
-T ---
*/

/** Normaliza caminho de projeto: barras invertidas → barras e remove a barra final. */
export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/$/, '')
}