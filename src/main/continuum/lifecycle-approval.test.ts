import { beforeEach, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ focused: true, visible: true, destroyed: false, available: true, dialog: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => native.available ? { isDestroyed: () => native.destroyed, isVisible: () => native.visible, isFocused: () => native.focused } : null }, dialog: { showMessageBox: native.dialog } }))
import { approveLifecycleInDesktop } from './lifecycle-approval'
import type { LifecycleReview } from './artifact-lifecycle'
const review: LifecycleReview = { repositoryId: 'repo-A', target: { artifactId: 'artifact-fixture', revision: 4, contentHash: 'a'.repeat(64), kind: 'ARCHITECTURAL_DECISION' }, supporting: null, toState: 'ACTIVE', reasonCode: 'NORMATIVE_ACTIVATION', evidence: [], reviewDigest: 'b'.repeat(64) }
beforeEach(() => { native.focused = native.visible = native.available = true; native.destroyed = false; native.dialog.mockReset() })
it.each(['available', 'focused', 'visible', 'destroyed'] as const)('does not request approval without a usable focused desktop: %s', async field => {
  native[field] = field === 'destroyed'
  expect(await approveLifecycleInDesktop(review)).toBeNull()
  expect(native.dialog).not.toHaveBeenCalled()
})
it.each([{ response: 0, checkboxChecked: true }, { response: 1, checkboxChecked: false }])('rejects cancel or unchecked criteria review', async result => {
  native.dialog.mockResolvedValue(result)
  expect(await approveLifecycleInDesktop(review)).toBeNull()
})
it('requires explicit criteria review and defaults to cancellation; records native source without inventing identity', async () => {
  native.dialog.mockResolvedValue({ response: 1, checkboxChecked: true })
  expect(await approveLifecycleInDesktop(review)).toMatchObject({ reviewDigest: review.reviewDigest, source: 'NATIVE_DESKTOP_CONFIRMATION', principalId: null })
  const options = native.dialog.mock.calls[0][1]
  expect(options).toMatchObject({ defaultId: 0, cancelId: 0, checkboxChecked: false })
  expect(options.detail).toContain('artifact-fixture@4'); expect(options.detail).toContain(review.target.contentHash)
})
