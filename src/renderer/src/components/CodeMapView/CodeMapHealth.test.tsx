// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeMapHealth } from './CodeMapHealth'

describe('CodeMapHealth', () => {
  afterEach(cleanup)

  it('keeps routine sync implicit and exposes recovery actions in health details', () => {
    const onVerifyIntegrity = vi.fn()
    const onRebuild = vi.fn()
    render(
      <CodeMapHealth
        state="healthy"
        indexedAt="2026-09-07T12:00:00.000Z"
        lastSyncAt={null}
        modifiedCount={0}
        integrityState="unknown"
        integrityIssueCount={0}
        isVerifying={false}
        isRebuilding={false}
        onVerifyIntegrity={onVerifyIntegrity}
        onShowIntegrityIssues={vi.fn()}
        onRebuild={onRebuild}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Code Map Health: Healthy' }))
    expect(screen.getByText('Auto-sync').parentElement?.textContent).toContain('Active')
    expect(screen.queryByText(/Sync changes/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Integrity Check' }))
    fireEvent.click(screen.getByText('Advanced'))
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild Index' }))
    expect(onVerifyIntegrity).toHaveBeenCalledOnce()
    expect(onRebuild).toHaveBeenCalledOnce()
  })

  it('surfaces integrity issues as the compact health state', () => {
    const onShowIntegrityIssues = vi.fn()
    render(
      <CodeMapHealth
        state="issue"
        indexedAt="2026-09-07T12:00:00.000Z"
        lastSyncAt={null}
        modifiedCount={0}
        integrityState="issue"
        integrityIssueCount={2}
        isVerifying={false}
        isRebuilding={false}
        onVerifyIntegrity={vi.fn()}
        onShowIntegrityIssues={onShowIntegrityIssues}
        onRebuild={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Code Map Health: Issue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review issues' }))
    expect(screen.getByText('2 issue(s)')).toBeTruthy()
    expect(onShowIntegrityIssues).toHaveBeenCalledOnce()
  })
})
