import type { PreviewSelection } from './runtime-preview-types'
export interface PreviewBuildRequest { selection: PreviewSelection; allowDirty: boolean; captureId?: string }
export type PreviewBuildResult = { success: true; captureId: string; buildId: string; runtimeId: string; reused: boolean; bundleDirectory: string;
  compatibility: { electron: string; node: string; abi: string; platform: string; arch: string; buildNode: string; nativeModules: string[] } } |
  { success: false; code: string; captureId?: string }
