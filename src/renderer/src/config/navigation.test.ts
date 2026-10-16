import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, normalizeHiddenNavigationItems, visibleNavigationItems } from './navigation'

describe('navigation visibility projection', () => {
  it.each([undefined, null, {}, 'academy', 42, []])('defaults to all destinations for %j', value => {
    expect(visibleNavigationItems(value)).toEqual(NAV_ITEMS)
  })
  it('keeps only known optional IDs once, in canonical order', () => {
    expect(normalizeHiddenNavigationItems(['home', 'academy', null, {}, 'unknown', 'academy', 'channel']))
      .toEqual(['channel', 'academy'])
    expect(visibleNavigationItems(['academy']).map(item => item.id)).toEqual(NAV_ITEMS.filter(item => item.id !== 'academy').map(item => item.id))
  })
  it('can hide every optional destination and restore every one', () => {
    expect(visibleNavigationItems(NAV_ITEMS.map(item => item.id)).map(item => item.id)).toEqual(['home'])
    expect(visibleNavigationItems([])).toEqual(NAV_ITEMS)
  })
  it('shows a newly added destination without updating the persisted denylist', () => {
    const hidden = NAV_ITEMS.filter(item => item.id !== 'home').map(item => item.id)
    const future = { ...NAV_ITEMS[1], id: 'future' as typeof NAV_ITEMS[number]['id'] }
    NAV_ITEMS.push(future)
    try { expect(visibleNavigationItems(hidden).map(item => item.id)).toEqual(['home', 'future']) }
    finally { NAV_ITEMS.pop() }
  })
})
