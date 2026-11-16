import { homedir } from 'node:os'
import { join } from 'node:path'
import { desktopUserData } from '../../shared/desktop-profile.cjs'
import { ConsentStore } from './consent-store'
import { NativeMessagingBridge } from './native-messaging-bridge'
import { runNativeStdioLoop } from './native-messaging-protocol'
import { DEFAULT_ALLOWED_WEB_ORIGINS } from './web-activation-types'

function resolveUserDataPath(): string {
  if (process.env.CODE_AWARENESS_USER_DATA && process.env.CODE_AWARENESS_USER_DATA.trim()) {
    return process.env.CODE_AWARENESS_USER_DATA.trim()
  }
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return desktopUserData(appData)
}

function splitEnvList(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) return undefined
  const items = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return items.length > 0 ? items : undefined
}

export async function runWebActivationNativeHost(argv = process.argv.slice(2)): Promise<void> {
  const callerOrigin =
    argv.find((arg) => /^chrome-extension:\/\//i.test(arg)) ??
    process.env.CODE_AWARENESS_CALLER_ORIGIN

  const userDataPath = resolveUserDataPath()
  const consentStore = new ConsentStore(join(userDataPath, 'web-activation'))
  const bridge = new NativeMessagingBridge({
    consentStore,
    callerOrigin,
    requireCallerOrigin: process.env.CODE_AWARENESS_ALLOW_UNIDENTIFIED_CALLER !== '1',
    allowedExtensionOrigins: splitEnvList(process.env.CODE_AWARENESS_ALLOWED_EXTENSION_ORIGINS),
    allowedWebOrigins: splitEnvList(process.env.CODE_AWARENESS_ALLOWED_WEB_ORIGINS) ?? DEFAULT_ALLOWED_WEB_ORIGINS,
    userDataPath
  })

  await runNativeStdioLoop(process.stdin, process.stdout, (message) => bridge.handle(message))
}

if (require.main === module) {
  void runWebActivationNativeHost().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
