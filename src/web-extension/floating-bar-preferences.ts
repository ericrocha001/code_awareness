import type { ContextPickerSite } from '../shared/web-activation/context-picker-sites'

export const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
export type Position = typeof positions[number]
export const defaultPosition: Position = 'bottom-right'
export const floatingBarVisibleKey = 'floatingBarVisible'

export function visibilityKey(site?: ContextPickerSite): string {
  return site ? `${floatingBarVisibleKey}.${site}` : floatingBarVisibleKey
}

export function positionKey(site?: ContextPickerSite): string {
  return site ? `floatingBarPosition.${site}` : 'floatingBarPosition'
}

export function compactKey(site: ContextPickerSite): string {
  return `floatingBarCompact.${site}`
}

export function readPosition(value: unknown): Position | undefined {
  return positions.find(position => position === value)
}

export function resolveBarPreferences(items: Record<string, unknown>, site?: ContextPickerSite) {
  const defaultLocation = readPosition(items[positionKey()]) ?? defaultPosition
  const override = site ? readPosition(items[positionKey(site)]) : undefined
  const masterVisible = items[visibilityKey()] !== false
  const siteVisible = !site || items[visibilityKey(site)] !== false
  return { defaultLocation, override, position: override ?? defaultLocation, masterVisible, siteVisible,
    visible: masterVisible && siteVisible, compact: Boolean(site && items[compactKey(site)] === true) }
}
