import { expect, it } from 'vitest'
import { AtlasCache } from './git-atlas-cache'

it('bounds memory and evicts least recently used values while isolating consumers', () => {
  const cache = new AtlasCache(2, 100)
  cache.set('a', { value: 1 }); cache.set('b', { value: 2 })
  cache.get<{ value: number }>('a')!.value = 99
  cache.set('c', { value: 3 })
  expect(cache.get('b')).toBeUndefined()
  expect(cache.get('a')).toEqual({ value: 1 })
  cache.set('oversize', 'x'.repeat(101)); expect(cache.get('oversize')).toBeUndefined()
  const bounded = new AtlasCache(10, 30)
  bounded.set('a', 'a'.repeat(20)); bounded.set('b', 'b'.repeat(20))
  expect(bounded.get('a')).toBeUndefined()
  bounded.clear(); expect(bounded.get('b')).toBeUndefined()
})
