import { expect, it } from 'vitest'
import { decideAcademyReconciliation, managedConflictPaths } from './academy-git-reconciliation'

it.each([
  ['baseline', 'canonical', 'canonical', true, 'CONVERGED'],
  ['baseline', 'baseline', 'new canonical', true, 'PUBLISH'],
  ['canonical', 'canonical', 'canonical', true, 'CONVERGED'],
  ['baseline', 'external', 'canonical', true, 'CONFLICT'],
  [null, 'external', 'canonical', true, 'CONFLICT'],
  [null, '', 'canonical', false, 'PUBLISH'],
  ['baseline', '', 'canonical', false, 'CONFLICT']
])('classifies content without requiring matching HEAD identities', (baseline, remote, canonical, exists, decision) => {
  expect(decideAcademyReconciliation(baseline as string | null, remote as string, canonical as string, exists as boolean)).toBe(decision)
})

it('projects only changed, added and removed managed paths, including file modes', () => {
  expect(managedConflictPaths('100644 blob a\tskills/alpha/SKILL.md\0' + '100644 blob b\tplugin.json\0', '100755 blob a\tskills/alpha/SKILL.md\0' + '100644 blob c\tassets/logo.png\0')).toEqual(['assets/logo.png', 'plugin.json', 'skills/alpha/SKILL.md'])
})
