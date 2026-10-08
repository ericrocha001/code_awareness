declare module 'js-yaml' {
  export const JSON_SCHEMA: unknown
  export function dump(value: unknown, options?: { lineWidth?: number; quotingType?: '"' | "'"; forceQuotes?: boolean }): string
  export function load(input: string, options?: { schema?: unknown }): unknown
}
