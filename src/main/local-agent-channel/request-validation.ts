export function invalid(): never { throw new Error('INVALID_ARGUMENT') }
export function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  if (keys && Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
export function text(value: unknown): string { if (typeof value !== 'string' || !value.trim()) invalid(); return value }
export function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(); return value }
export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()) || new Set(value).size !== value.length) invalid()
  return value as string[]
}
