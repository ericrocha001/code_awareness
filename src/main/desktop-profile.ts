import { join, resolve } from 'node:path'

export const DESKTOP_APP_NAME = 'code-awareness'

interface DesktopApplication {
  getName(): string
  getPath(name: 'appData' | 'userData'): string
}

export function canonicalDesktopProfile(appData: string) {
  return desktopProfilePaths(join(appData, DESKTOP_APP_NAME))
}

export function desktopProfilePaths(userData: string) {
  return { appName: DESKTOP_APP_NAME, userData, settingsPath: join(userData, 'settings.json'), installationPath: join(userData, 'installation') }
}

export function assertCanonicalDesktopProfile(app: DesktopApplication) {
  const expected = canonicalDesktopProfile(app.getPath('appData'))
  const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  if (app.getName() !== expected.appName || normalize(app.getPath('userData')) !== normalize(expected.userData)) {
    throw Object.assign(new Error('NON_CANONICAL_DESKTOP_PROFILE'), {
      code: 'NON_CANONICAL_DESKTOP_PROFILE', stage: 'profile',
      expected: { appName: expected.appName, userData: expected.userData },
      actual: { appName: app.getName(), userData: app.getPath('userData') }
    })
  }
  return expected
}
