// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ActiveProjectState } from '../../shared/types/active-project-types'
import { App } from './App'

const { sidebar } = vi.hoisted(() => ({ sidebar: vi.fn() }))
vi.mock('./components/GlobalSidebar/GlobalSidebar', () => ({ GlobalSidebar: (props: unknown) => { sidebar(props); return null } }))
vi.mock('./components/CodeDiffView/CodeDiffView', () => ({ CodeDiffView: () => null }))
vi.mock('./components/CodeCompressionView/CodeCompressionView', () => ({ CodeCompressionView: () => null }))
vi.mock('./components/CodeSourceView/CodeSourceView', () => ({ CodeSourceView: () => null }))
vi.mock('./components/CodeCampaignView/CodeCampaignView', () => ({ CodeCampaignView: () => null }))
vi.mock('./components/CodeJourneyView/CodeJourneyView', () => ({ CodeJourneyView: () => null }))
vi.mock('./components/CodeMapView/CodeMapView', () => ({ CodeMapView: () => null }))
vi.mock('./components/CodeDashView/CodeDashView', () => ({ CodeDashView: () => null }))
vi.mock('./components/HomeView/HomeView', () => ({ HomeView: () => null }))
vi.mock('./components/TagManagerModal/TagManagerModal', () => ({ TagManagerModal: () => null }))
vi.mock('./components/CodeAwarenessIgnoreModal/CodeAwarenessIgnoreModal', () => ({ CodeAwarenessIgnoreModal: () => null }))
vi.mock('./hooks/useTheme', () => ({ useTheme: () => {} }))
vi.mock('./hooks/useProjectPreferences', () => ({ useProjectPreferences: () => ({ preferences: { sidebarOpen: true }, updateSidebarOpen: vi.fn() }) }))

let receive: (state: ActiveProjectState) => void
const unsubscribe = vi.fn()
const state = (id: string, revision: number): ActiveProjectState => ({ revision, project: { id, path: `/projects/${id}`, name: id } })
const current = () => sidebar.mock.calls.at(-1)![0]

beforeEach(() => {
  sidebar.mockClear()
  unsubscribe.mockClear()
  window.codeAwareness = {
    getPendingDeepLink: vi.fn(async () => null),
    onDeepLink: vi.fn(() => () => {}),
    getActiveProject: vi.fn(async () => state('A', 1)),
    onActiveProjectChanged: vi.fn((callback) => { receive = callback; return unsubscribe }),
    activateRepository: vi.fn(async () => ({ success: true }))
  } as unknown as Window['codeAwareness']
})
afterEach(cleanup)

it('rehydrates from main and only renders confirmed selection changes', async () => {
  const view = render(<App />)
  await waitFor(() => expect(current().activeProject?.id).toBe('A'))
  await act(async () => current().onSelectRepository('catalog-B'))
  expect(window.codeAwareness.activateRepository).toHaveBeenCalledWith('catalog-B')
  expect(current().activeProject.id).toBe('A')
  act(() => receive(state('B', 2)))
  expect(current().activeProject.id).toBe('B')
  act(() => receive({ revision: 3, project: null }))
  expect(current().activeProject).toBeNull()
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it('does not overwrite a newer event with an older hydration response', async () => {
  let hydrate!: (value: ActiveProjectState) => void
  vi.mocked(window.codeAwareness.getActiveProject).mockReturnValue(new Promise((resolve) => { hydrate = resolve }))
  render(<App />)
  act(() => receive(state('B', 2)))
  await act(async () => hydrate(state('A', 1)))
  expect(current().activeProject.id).toBe('B')
})

it('does not report an obsolete catalog selection when activation completes out of order', async () => {
  let finishA!: (value: { success: boolean }) => void
  vi.mocked(window.codeAwareness.activateRepository).mockImplementationOnce(() => new Promise((resolve) => { finishA = resolve }))
  render(<App />)
  await waitFor(() => expect(current().activeProject?.id).toBe('A'))
  let first!: Promise<void>
  act(() => { first = current().onSelectRepository('catalog-A') })
  await act(async () => current().onSelectRepository('catalog-B'))
  await act(async () => { finishA({ success: true }); await first })
  expect(window.codeAwareness.activateRepository).toHaveBeenCalledTimes(2)
})
