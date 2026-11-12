import type { AcademyOpenAiPublicationState, AcademyPluginCoverage, AcademyPluginExcludedSkill } from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import { pluginInclusion } from './openai-plugin-model'

const EXCLUSION_ACTION = { PRIVATE: 'APPROVE_PUBLICATION', DISABLED: 'ENABLE_SKILL', REMOVED: 'REINTRODUCE_SKILL' } as const

export function buildPluginCoverage(store: AcademyStore, release: AcademyOpenAiPublicationState['selectedRelease']): AcademyPluginCoverage | undefined {
  if (store.usesGitFirst()) return undefined
  const included = new Set<string>(), excluded: AcademyPluginExcludedSkill[] = []
  let catalog = 0, notApplicable = 0
  const shipped = new Map(release?.snapshot.map(entry => [entry.skillId, entry]))
  let awaitingZip = 0
  for (const skill of store.list()) {
    const inclusion = pluginInclusion(store, skill)
    if (inclusion !== 'REMOVED') catalog++
    if (inclusion === 'NOT_APPLICABLE') notApplicable++
    else if (inclusion === 'INCLUDED') {
      included.add(skill.id)
      if (release && shipped.get(skill.id)?.academyVersion !== skill.currentVersion) awaitingZip++
    } else excluded.push({ skillId: skill.id, name: skill.name, version: skill.currentVersion, reason: inclusion, action: EXCLUSION_ACTION[inclusion] })
  }
  return {
    catalog, eligible: included.size, includedInLastZip: release ? release.snapshot.length : null,
    awaitingZip: release ? awaitingZip + [...shipped.keys()].filter(id => !included.has(id)).length : 0,
    notApplicable, excluded, preference: store.getPublicationPreference()
  }
}
