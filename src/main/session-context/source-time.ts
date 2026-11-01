import { z } from 'zod'

const schema = z.string().max(80).datetime({ offset: true })
export function sourceTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && schema.safeParse(value).success && Number.isFinite(Date.parse(value)) ? value : undefined
}
export function compareSourceTime(a: string, b: string): number {
  const milliseconds = Date.parse(a) - Date.parse(b)
  if (milliseconds) return Math.sign(milliseconds)
  const tail = (value: string) => (/\.(\d+)/.exec(value)?.[1] ?? '').slice(3)
  const left = tail(a), right = tail(b), precision = Math.max(left.length, right.length)
  const x = left.padEnd(precision, '0'), y = right.padEnd(precision, '0')
  return x < y ? -1 : x > y ? 1 : 0
}
