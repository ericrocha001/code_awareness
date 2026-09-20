export async function hashInstallationCredential(credential: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyInstallationCredential(credential: string, expectedHash: string): Promise<boolean> {
  const actual = await hashInstallationCredential(credential)
  if (expectedHash.length !== actual.length) return false
  let difference = 0
  for (let index = 0; index < actual.length; index++) difference |= actual.charCodeAt(index) ^ expectedHash.charCodeAt(index)
  return difference === 0
}
