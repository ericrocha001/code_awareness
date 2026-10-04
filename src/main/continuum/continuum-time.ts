export function detectSystemTimeZone(): string {
  try {
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof timeZone === 'string' && timeZone.length > 0) return timeZone
  } catch {
    // Fall through to UTC fallback
  }
  return 'UTC'
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function getOffsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(instant)

  const lookup: Record<string, number> = {}
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = Number(part.value)
  }
  const wallAsUtc = Date.UTC(
    lookup.year,
    lookup.month - 1,
    lookup.day,
    lookup.hour === 24 ? 0 : lookup.hour,
    lookup.minute,
    lookup.second
  )
  return Math.round((wallAsUtc - instant.getTime()) / 60000)
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

export function toLocalTimestamp(utcIso: string, timeZone: string): string {
  const instant = new Date(utcIso)
  if (Number.isNaN(instant.getTime())) return utcIso
  let zone = timeZone
  try {
    getOffsetMinutes(zone, instant)
  } catch {
    zone = 'UTC'
  }
  const offsetMinutes = getOffsetMinutes(zone, instant)
  const wall = new Date(instant.getTime() + offsetMinutes * 60000)
  const millis = pad(instant.getUTCMilliseconds(), 3)
  return (
    `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
    `.${millis}${formatOffset(offsetMinutes)}`
  )
}

export interface LocalizedTimestamps {
  timeZone: string
  createdAtLocal: string
  ingestedAtLocal: string
}

export function contextualizeTimestamps(
  createdAt: string,
  ingestedAt: string,
  timeZone: string = detectSystemTimeZone()
): LocalizedTimestamps {
  let zone = timeZone
  if (!zone) zone = 'UTC'
  try {
    getOffsetMinutes(zone, new Date(createdAt))
  } catch {
    zone = 'UTC'
  }
  return {
    timeZone: zone,
    createdAtLocal: toLocalTimestamp(createdAt, zone),
    ingestedAtLocal: toLocalTimestamp(ingestedAt, zone)
  }
}
