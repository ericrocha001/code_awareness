import { useEffect, useState } from 'react'

type Activity = { quiescent: boolean; controlId: string }
declare global {
  interface Window { __runtimePreview?: { initialized(report: unknown): void; onActivity(callback: (value: Activity) => void): () => void; activityConfirmed(value: Activity & { functional: boolean }): void } }
}
export function usePreviewActivity() {
  const [activity, setActivity] = useState<Activity>({ quiescent: false, controlId: '' })
  useEffect(() => window.__runtimePreview?.onActivity(value => {
    if (typeof value?.quiescent === 'boolean' && typeof value.controlId === 'string') setActivity(value)
  }), [])
  useEffect(() => {
    if (!window.__runtimePreview) return
    document.documentElement.toggleAttribute('data-preview-quiescent', activity.quiescent)
    let cancelled = false
    const acknowledge = () => { if (!cancelled) window.__runtimePreview?.activityConfirmed({ ...activity, functional: !activity.quiescent && document.hasFocus() && !!document.querySelector('.app-main') }) }
    if (activity.quiescent) acknowledge()
    else requestAnimationFrame(() => requestAnimationFrame(acknowledge))
    return () => { cancelled = true }
  }, [activity])
  return !activity.quiescent
}
