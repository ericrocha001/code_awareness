export const ENTIRE_SESSION_SCHEMA = 'entire-session-metadata-v1'
export function entireAgent(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9 _-]{0,79}$/.test(value)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
  return value.trim().toLowerCase().replace(/\s+/g, '-')
}
export function supportsEntireMetadata(version: string): boolean {
  return version === '0.12.2'
}
