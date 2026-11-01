import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { CliCommandDescriptor } from './cli-execution-types'

export function isConsultativeCommand(command: CliCommandDescriptor): boolean {
  if (process.platform !== 'win32' || command.args.length || command.windowsCommandLine) return false
  for (const name of ['whoami.exe', 'hostname.exe']) {
    try {
      const system = realpathSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', name))
      if (command.executable === system) return true
    } catch {}
  }
  return false
}
