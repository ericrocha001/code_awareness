export interface LocalRequestContext { connected(): boolean }
export interface LocalOperation { execute(input: unknown, context: LocalRequestContext): unknown | Promise<unknown> }
export interface LocalChannelAdapter { readonly domain: string; readonly operations: Readonly<Record<string, LocalOperation>> }
export function operation<T>(parse: (input: unknown) => T, execute: (request: T, context: LocalRequestContext) => unknown | Promise<unknown>): LocalOperation {
  return { execute: (input, context) => execute(parse(input), context) }
}
