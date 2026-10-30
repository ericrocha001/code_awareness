export interface NativeAcceptanceCommand {
  executable: string
  args: readonly string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  buildLog?: string
}
/** Describes the spawned process; session and Job cleanup remain supervisor-owned. */
export interface NativeProcessReceipt {
  status: 'EXITED' | 'TIMED_OUT' | 'PREPARATION_FAILED'
  exitCode: number | null
  signal: NodeJS.Signals | null
}
export interface NativeAcceptanceInput {
  prepare: () => NativeAcceptanceCommand | Promise<NativeAcceptanceCommand>
  observe?: (context: {
    process: Readonly<NativeProcessReceipt>
    readBuildLog: (maxBytes?: number) => Promise<string>
  }) => void | Promise<void>
}
export interface NativeAcceptanceResult {
  state: 'PASS' | 'COMPILER_FAILED' | 'TIMED_OUT' | 'PREPARATION_FAILED' | 'HARNESS_FAILED'
  process: Readonly<NativeProcessReceipt>
  observer: 'NOT_RUN' | 'PASSED' | 'FAILED'
}
export function runNativeAcceptance(input: NativeAcceptanceInput): Promise<NativeAcceptanceResult>
