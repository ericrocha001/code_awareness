export interface AcademyIdentityEntry {
  skillId: string
  path: string
  state: 'PRESENT' | 'REMOVED'
  baseHash?: string
  revision?: number
}
export interface AcademyIdentityCatalog { schema: 2; skills: AcademyIdentityEntry[] }
export const IDENTITY_PATH: string
export function validateAcademyIdentities(value: unknown, paths: string[], previous?: AcademyIdentityCatalog): AcademyIdentityCatalog
