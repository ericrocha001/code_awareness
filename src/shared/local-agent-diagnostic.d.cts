export interface LocalAgentDiagnostic { code: string; stage?: string; reason?: string; operation?: string }
export function safeDiagnostic(error: unknown, fallback?: string): LocalAgentDiagnostic
