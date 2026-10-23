import type { ContinuumBundleQuick, ContinuumBundleReceipt, ContinuumBundlePrepare, ContinuumBundlePreview, ContinuumBundleExport } from '../../shared/types/continuum-bundle-types'
import type { ContinuumTag, ContinuumTagMutation } from '../../shared/types/continuum-tag-types'
/*
-T ---
*/

/// <reference types="vite/client" />
import type { ActiveProjectState } from '../../shared/types/active-project-types'
import type { GitAtlasRequest, GitAtlasPage, GitAtlasCompareRequest, GitAtlasComparison } from '../../shared/types/git-atlas-types'
import type { AtlasCatalogRequest, AtlasCatalogState, AtlasCatalogChange } from '../../shared/types/git-atlas-catalog-types'
import type { GitAtlasCoreRequest, GitAtlasCoreEvidence, GitAtlasPrRequest, GitAtlasPrEvidence } from '../../shared/types/git-atlas-evidence-types'
import type { OrchestrationRequest, OrchestrationResult, OrchestrationData } from '../../shared/types/work-orchestration-types'
import type { OrchestrationAttentionChange } from '../../shared/types/work-orchestration-attention-types'
import type { GitCommitCorrelationRequest, GitCommitCorrelationPage } from '../../shared/types/git-commit-correlation-types'
import type { GitHistoryRequest, GitHistoryPage, GitManagementResult, GitManagementContext, GitOverview, GitCommitRequest, GitCommitDetail, GitPatchRequest, GitPatch, GitMutationRequest, GitOperationalResult } from '../../shared/types/git-management-types'
import type { ContinuumExportRequest, ContinuumExportReceipt, ContinuumChange, ContinuumFacets, ContinuumListRequest, ContinuumSelection, ContinuumTimeline, ContinuumPublishRequest, ContinuumPublishReceipt } from '../../shared/types/continuum-ui-types'
import type { ContinuumGraphRequest, ContinuumGraph } from '../../shared/types/continuum-graph-types'
import type { ContinuumSuggestionRequest, ContinuumSuggestions } from '../../shared/types/continuum-suggestion-types'
import type { ContinuumVisualPublishRequest, ContinuumVisualSelection } from '../../shared/types/continuum-ui-types'
import type { ConnectionResult, ConnectionState } from '../../shared/types/connection-types'
import type { ChannelState } from '../../shared/types/channel-state-types'
import type { SystemHealthState } from '../../shared/types/system-health-types'
import type { AcademyCreateInput, AcademyDistributionHealth, AcademyDistributionState, AcademyGitStatusProjection, AcademyImportItem, AcademyOpenAiPluginProfile, AcademyOpenAiPublicationState, AcademyOpenAiRelease, AcademyPackage, AcademyPackageDistributionState, AcademySnapshot, AcademySkillDetail, AcademySkillVersion, AcademyUpdateInput } from '../../shared/types/academy-types'
import type { RepositoryRecord } from '../../shared/types/repository-catalog-types'
import type { GitHubCreateRepositoryInput, GitHubOperationResult, GitHubPublishRepositoryInput, GitHubStatusProjection } from '../../shared/types/github-types'

import { ActionLog, AppSettings, Campaign, CampaignStatus, CheckpointData, CheckpointDetails, CheckpointDiffFile, CheckpointSummary, CodefetchResult, CompressionSettingsPayload, DiffFileStatus, OrphanFile, OutputFormat, ProjectInfo, RestoreExecuteOptions, RestoreExecuteResult, RestorePreviewResult, Tag, DashExecutionResult } from '../../shared/types'

declare global {
  interface Window {
    codeAwareness: {
      getBranchOrchestration: (request: import('../../shared/types/branch-manager-types').BranchManagerRequest) => Promise<import('../../shared/types/branch-manager-types').BranchManagerResult>
      getWorkOrchestration: (request: OrchestrationRequest) => Promise<OrchestrationResult<OrchestrationData>>
      onWorkOrchestrationChanged: (callback: (change: OrchestrationAttentionChange) => void) => () => void
      getGitManagementHistory: (request: GitHistoryRequest) => Promise<GitManagementResult<GitHistoryPage>>
      getGitAtlas: (request: GitAtlasRequest) => Promise<GitManagementResult<GitAtlasPage>>
      getGitAtlasCheckoutState: (context: GitManagementContext, lightweight?: boolean) => Promise<GitManagementResult<import('../../shared/types/git-atlas-types').GitAtlasCheckoutObservation>>
      getGitAtlasCatalog: (request: AtlasCatalogRequest) => Promise<GitManagementResult<AtlasCatalogState>>
      stopGitAtlasCollection: (context: GitManagementContext) => Promise<GitManagementResult<void>>
      onGitAtlasCatalogChanged: (callback: (change: AtlasCatalogChange) => void) => () => void
      getGitAtlasCore: (request: GitAtlasCoreRequest) => Promise<GitManagementResult<GitAtlasCoreEvidence>>
      getGitAtlasPrEvidence: (request: GitAtlasPrRequest) => Promise<GitManagementResult<GitAtlasPrEvidence>>
      compareGitAtlas: (request: GitAtlasCompareRequest) => Promise<GitManagementResult<GitAtlasComparison>>
      getGitCommitCorrelation: (request: GitCommitCorrelationRequest) => Promise<GitManagementResult<GitCommitCorrelationPage>>
      getGitManagementOverview: (context: GitManagementContext) => Promise<GitManagementResult<GitOverview>>
      getGitManagementCommit: (request: GitCommitRequest) => Promise<GitManagementResult<GitCommitDetail>>
      getGitManagementPatch: (request: GitPatchRequest) => Promise<GitManagementResult<GitPatch>>
      mutateGitManagement: (request: GitMutationRequest) => Promise<GitManagementResult<GitOperationalResult>>
      listContinuumArtifacts: (request: ContinuumListRequest) => Promise<ContinuumTimeline>
      getContinuumGraph: (request: ContinuumGraphRequest) => Promise<ContinuumGraph>
      getContinuumSuggestions: (request: ContinuumSuggestionRequest) => Promise<ContinuumSuggestions>
      publishContinuumArtifact: (request: ContinuumPublishRequest) => Promise<ContinuumPublishReceipt>
      publishContinuumVisual: (request: ContinuumVisualPublishRequest) => Promise<ContinuumPublishReceipt>
      getContinuumVisual: (repositoryId: string, artifactId: string) => Promise<ContinuumVisualSelection>
      getContinuumVisualThumbnail: (repositoryId: string, artifactId: string) => Promise<ContinuumVisualSelection>
      getContinuumFacets: (repositoryPath: string) => Promise<ContinuumFacets>
      getContinuumTags: (repositoryId: string) => Promise<{ repositoryId: string; tags: ContinuumTag[] }>
      mutateContinuumTags: (request: ContinuumTagMutation) => Promise<{ repositoryId: string; tags: ContinuumTag[] }>
      quickContinuumBundle: (request: ContinuumBundleQuick) => Promise<ContinuumBundleReceipt>
      prepareContinuumBundle: (request: ContinuumBundlePrepare) => Promise<ContinuumBundlePreview>
      exportContinuumBundle: (request: ContinuumBundleExport) => Promise<{ outcome: 'copied' | 'saved' | 'cancelled'; snapshotId: string }>
      exportContinuumArtifact: (request: ContinuumExportRequest) => Promise<ContinuumExportReceipt>
      getContinuumArtifact: (repositoryId: string, artifactId: string) => Promise<ContinuumSelection>
      onContinuumChanged: (callback: (change: ContinuumChange) => void) => () => void
      getAcademySnapshot: () => Promise<AcademySnapshot>
      getAcademyGitStatus: () => Promise<AcademyGitStatusProjection>
      syncAcademyGitNow: () => Promise<AcademyGitStatusProjection>
      resolveAcademyGitConflict: (expectedRemoteHead: string | null, expectedDesiredTree: string) => Promise<AcademyGitStatusProjection>
      bindAcademyGitRepository: (repositoryCatalogId: string) => Promise<AcademyGitStatusProjection>
      listAcademyGitEligibleRepositories: () => Promise<RepositoryRecord[]>
      openAcademyGitRepository: () => Promise<boolean>
      getAcademySkill: (id: string) => Promise<AcademySkillDetail>
      getAcademyHistory: (id: string) => Promise<AcademySkillVersion[]>
      createAcademySkill: (input: Omit<AcademyCreateInput, 'origin'>) => Promise<AcademySkillDetail>
      updateAcademySkill: (input: Omit<AcademyUpdateInput, 'origin'>) => Promise<AcademySkillDetail>
      archiveAcademySkill: (id: string, expectedVersion: number) => Promise<AcademySkillDetail>
      restoreAcademySkill: (id: string, expectedVersion: number) => Promise<AcademySkillDetail>
      setAcademyDestinationEnabled: (id: string, enabled: boolean) => Promise<unknown>
      importAcademyDestination: (id: string) => Promise<AcademyImportItem[]>
      reviewAcademyConflict: (id: string, reconciledPackage?: AcademyPackage) => Promise<import('../../shared/types/academy-types').AcademyConflictReview>
      previewAcademyConflictBatch: () => Promise<import('../../shared/types/academy-types').AcademyConflictBatch>
      resolveAcademyConflictBatch: (token: string, confirmed: boolean) => Promise<{ resolved: number; remaining: number }>
      resolveAcademyConflict: (id: string, resolution: 'CANONICAL' | 'DIVERGENT', reconciledPackage?: AcademyPackage, approval?: { token: string; confirmed: boolean }) => Promise<AcademySkillDetail>
      getAcademyDistributionHealth: () => Promise<AcademyDistributionHealth>
      listAcademyDistributionStates: (skillId?: string) => Promise<AcademyDistributionState[]>
      reconcileAcademyDistribution: (destinationId?: string) => Promise<{ health: AcademyDistributionHealth; states: AcademyDistributionState[] }>
      bootstrapAcademyOpenAiPlugin: (publishedVersion?: string) => Promise<AcademyOpenAiPluginProfile>
      getAcademyOpenAiPublicationState: () => Promise<AcademyOpenAiPublicationState>
      getAcademyPackageDistributionState: () => Promise<AcademyPackageDistributionState>
      listAcademyOpenAiReleases: () => Promise<AcademyOpenAiRelease[]>
      prepareAcademyOpenAiRelease: () => Promise<AcademyOpenAiRelease>
      confirmAcademyOpenAiUpload: (releaseId: string, artifactHash: string) => Promise<AcademyOpenAiRelease>
      revealAcademyOpenAiPackage: (releaseId: string) => Promise<boolean>
      getChannelState: () => Promise<ChannelState>
      localMcpClients: import('../../shared/types/local-mcp-client-types').LocalMcpClientApi
      onChannelChanged: (callback: (state: ChannelState) => void) => () => void
      getSystemHealthState: () => Promise<SystemHealthState>
      getSystemHealthDiagnosticReport: () => Promise<string>
      onSystemHealthChanged: (callback: (state: SystemHealthState) => void) => () => void
      getConnectionState: () => Promise<ConnectionResult>
      connect: () => Promise<ConnectionResult>
      disconnect: () => Promise<ConnectionResult>
      onConnectionChanged: (callback: (state: ConnectionState) => void) => () => void
      getActiveProject: () => Promise<ActiveProjectState>
      activateProject: (projectId: string | null) => Promise<{ success: boolean; data?: ActiveProjectState; error?: string; code?: string }>
      onActiveProjectChanged: (callback: (state: ActiveProjectState) => void) => () => void
      saveMarkdown: (markdown: string, repoName: string) => Promise<{ success: boolean; error?: string }>
      saveXml: (xml: string, repoName: string) => Promise<{ success: boolean; error?: string }>
      saveToDownloads: (markdown: string, baseFileName: string, outputFormat?: OutputFormat) => Promise<{ success: boolean; filePath?: string; error?: string }>
      exportToNotebookLM: (markdown: string, fileName: string) => Promise<{ success: boolean; fileCount: number; filePaths?: string[]; error?: string }>
      exportToDocx: (markdown: string, fileName: string) => Promise<{ success: boolean; fileCount: number; filePaths?: string[]; error?: string }>
      loadSettings: () => Promise<AppSettings>
      saveSettings: (settings: AppSettings) => Promise<{ success: boolean }>
      selectFolder: () => Promise<{ path: string; name: string } | null>
      selectDocumentForPropagation: () => Promise<{ path: string; name: string } | null>
      propagateDocument: (
        sourceFilePath: string,
        destinationRepoPaths: string[]
      ) => Promise<{ success: number; failed: number; errors: string[] }>
      getPathForFile: (file: File) => string
      checkRepository: (dirPath: string) => Promise<boolean>
      getModifiedFiles: (dirPath: string) => Promise<DiffFileStatus[]>
      startWatcher: (dirPath: string) => Promise<{ success: boolean }>
      stopWatcher: () => Promise<{ success: boolean }>
      onFileChanged: (callback: (filePath: string) => void) => () => void
      generateSemanticDiff: (repoPath: string, selectedFiles?: string[]) => Promise<string>
      getAllFiles: (dirPath: string) => Promise<DiffFileStatus[]>
      generateCompressionMarkdown: (repoPath: string, selectedFiles: string[], settings?: CompressionSettingsPayload) => Promise<string>
      listRepositories: () => Promise<RepositoryRecord[]>
      refreshRepositories: () => Promise<RepositoryRecord[]>
      importRepositoryRoot: () => Promise<RepositoryRecord[]>
      importLocalRepository: () => Promise<RepositoryRecord[]>
      hideRepository: (repositoryId: string) => Promise<RepositoryRecord[]>
      activateRepository: (repositoryId: string) => Promise<{ success: boolean; data?: ActiveProjectState; error?: string; code?: string }>
      getGitHubStatus: () => Promise<GitHubStatusProjection>
      connectGitHub: () => Promise<GitHubStatusProjection>
      cancelGitHubConnect: () => Promise<GitHubStatusProjection>
      openGitHubAuthorization: () => Promise<void>
      openGitHubInstallation: () => Promise<void>
      openGitHubManageAccess: () => Promise<void>
      disconnectGitHub: () => Promise<GitHubStatusProjection>
      refreshGitHub: () => Promise<GitHubOperationResult>
      cloneGitHubRepository: (repositoryId: string) => Promise<GitHubOperationResult>
      createGitHubRepository: (input: GitHubCreateRepositoryInput) => Promise<GitHubOperationResult>
      publishGitHubRepository: (input: GitHubPublishRepositoryInput) => Promise<GitHubOperationResult>
      addRootFolder: () => Promise<ProjectInfo[]>
      addIndividualProject: () => Promise<ProjectInfo[]>
      getProjectsList: () => Promise<ProjectInfo[]>
      hideProject: (projectPath: string) => Promise<ProjectInfo[]>
      addIgnoredFile: (repoPath: string, relativePath: string) => Promise<AppSettings | null>
      removeIgnoredFile: (repoPath: string, relativePath: string) => Promise<AppSettings | null>
      reconcileIgnoredFiles: (repoPath: string, currentModifiedFiles: string[]) => Promise<AppSettings | null>
      checkCodeSourceInstallation: () => Promise<boolean>
      generateCodeSourceWithProfile: (
        repoPath: string,
        selectedFiles: string[],
        format?: 'markdown' | 'xml',
        profile?: unknown,
        generationId?: number,
        sessionKey?: string
      ) => Promise<{
        success: boolean
        content?: string
        tokenCount?: number
        error?: string
        generationId?: number
      }>


      revealInExplorer: (repoPath: string, relativePath: string) => Promise<boolean>

      onThemeChanged: (callback: (isDarkMode: boolean) => void) => () => void



      // ─── Checkpoints ─────────────────────────────────────────────────
      createCheckpoint: (
        repoPath: string,
        name: string,
        details?: CheckpointDetails
      ) => Promise<{ success: boolean; data?: CheckpointData; error?: string }>

      listCheckpoints: (
        repoPath: string
      ) => Promise<{ success: boolean; data?: CheckpointSummary[]; error?: string }>

      loadCheckpoint: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; data?: CheckpointData; error?: string }>

      deleteCheckpoint: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; error?: string }>

      generateCheckpointDiff: (
        repoPath: string,
        fromCheckpointId: string,
        toCheckpointId: string
      ) => Promise<{ success: boolean; data?: string; error?: string }>

      renameCheckpoint: (
        repoPath: string,
        checkpointId: string,
        newName: string
      ) => Promise<{ success: boolean; error?: string }>

      getCheckpointChangedFiles: (
        repoPath: string,
        fromCheckpointId: string,
        toCheckpointId: string
      ) => Promise<{ success: boolean; data?: CheckpointDiffFile[]; error?: string }>

      updateCheckpointDetails: (
        repoPath: string,
        checkpointId: string,
        details: CheckpointDetails
      ) => Promise<{ success: boolean; error?: string }>

      setCheckpointCampaigns: (
        repoPath: string,
        checkpointId: string,
        campaignIds: string[]
      ) => Promise<{ success: boolean; error?: string }>

      // ─── Restauração ──────────────────────────────────────────────────

      restorePreview: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; data?: RestorePreviewResult; error?: string }>

      restoreExecute: (
        repoPath: string,
        checkpointId: string,
        options: RestoreExecuteOptions
      ) => Promise<{ success: boolean; data?: RestoreExecuteResult; error?: string; partial?: boolean }>

      restoreMarkManual: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; error?: string }>

      restoreUnmark: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; error?: string }>

      // ─── Tags Manuais ──────────────────────────────────────────────────

      getTags: (repoPath: string) => Promise<{ success: boolean; data?: Tag[]; error?: string }>

      upsertTag: (
        repoPath: string,
        tag: Tag
      ) => Promise<{ success: boolean; data?: Tag; error?: string }>

      deleteTag: (repoPath: string, tagId: string) => Promise<{ success: boolean; error?: string }>

      // ─── Associação Arquivo ↔ Tag ──────────────────────────────────────────

      getFileTags: (repoPath: string) => Promise<{ success: boolean; data?: Record<string, string[]>; error?: string }>

      setFileTag: (repoPath: string, relativePath: string, tagId: string) => Promise<{ success: boolean; error?: string }>

      removeFileTag: (repoPath: string, relativePath: string, tagId: string) => Promise<{ success: boolean; error?: string }>

      toggleDevTools: () => Promise<{ success: boolean }>

      // ─── Banco de Dados (Code Checkpoints) ───────────────────────────
      initializeDatabase: (repoPath: string) => Promise<{ success: boolean; error?: string }>
      insertAction: (action: Omit<ActionLog, 'id'>) => Promise<{ success: boolean; error?: string }>
      getActions: (repoPath: string, limit?: number) => Promise<{ success: boolean; data?: ActionLog[]; error?: string }>
      getActionsByDateRange: (repoPath: string, startDate: number, endDate: number) => Promise<{ success: boolean; data?: ActionLog[]; error?: string }>

      // ─── Code Campaign ──────────────────────────────────────────────────────
      createCampaign: (
        repoPath: string,
        data: { name: string; description?: string }
      ) => Promise<{ success: boolean; data?: Campaign; error?: string }>

      listCampaigns: (
        repoPath: string
      ) => Promise<{ success: boolean; data?: Campaign[]; error?: string }>

      getCampaign: (
        repoPath: string,
        campaignId: string
      ) => Promise<{ success: boolean; data?: Campaign | null; error?: string }>

      updateCampaign: (
        repoPath: string,
        campaignId: string,
        patch: { name?: string; description?: string; status?: CampaignStatus }
      ) => Promise<{ success: boolean; data?: Campaign; error?: string }>

      // ─── Deep Link ──────────────────────────────────────────────────────
      getPendingDeepLink: () => Promise<string | null>
      onDeepLink: (callback: (url: string) => void) => () => void

      // ─── Code Map ─────────────────────────────────────────────────────────────
      openRepository: (repoPath: string) => Promise<{ success: boolean; projectId?: string; error?: string; code?: string }>
      closeRepository: (repoPath: string) => Promise<{ success: boolean; error?: string; code?: string }>
      indexRepository: (repoPath: string) => Promise<{ success: boolean; data?: { filesIndexed: number; elementsExtracted: number }; error?: string }>
      synchronizeModified: (repoPath: string) => Promise<{ success: boolean; data?: { filesUpdated: number; errors: string[] }; error?: string }>
      getRepository: (repoPath: string) => Promise<{ success: boolean; data?: import('../../shared/types').CodeMapRepository | null; error?: string }>
      getFiles: (repoPath: string) => Promise<{ success: boolean; data?: import('../../shared/types').CodeMapFile[]; error?: string }>
      getElements: (repoPath: string) => Promise<{ success: boolean; data?: import('../../shared/types').CodeMapElement[]; error?: string }>
      getRelationships: (repoPath: string) => Promise<{ success: boolean; data?: import('../../shared/types').CodeMapRelationship[]; error?: string }>
      getSyncStatus: (repoPath: string) => Promise<{ success: boolean; data?: import('../../shared/types').CodeMapSyncStatus; error?: string }>
      getModifiedFilesCount: (repoPath: string) => Promise<{ success: boolean; data?: number; error?: string }>
      getElementSnippet: (repoPath: string, elementId: string) => Promise<{
        success: boolean
        data?: {
          content: string
          startLine: number
          startColumn: number
          endLine: number
          truncated: boolean
          relativePath: string
        } | null
        error?: string
      }>
      getFileContent: (repoPath: string, relativePath: string) => Promise<{
        success: boolean
        data?: {
          content: string
          relativePath: string
          truncated: boolean
          lines: number
          sizeBytes: number
        } | null
        error?: string
      }>
      openInVSCode: (repoPath: string, elementId: string) => Promise<{
        success: boolean
        usedFallback?: boolean
        error?: string
      }>
      verifyIntegrity: (repoPath: string, options?: { autoRepair?: boolean; selectedIssues?: string[]; issues?: import('../../shared/types').IntegrityIssue[] }) => Promise<{
        success: boolean
        data?: import('../../shared/types').IntegrityCheckResult
        error?: string
      }>
      generateScope: (repoPath: string, anchorFileId: string) => Promise<{
        success: boolean
        markdown?: string
        fileName?: string
        error?: string
      }>
      generateCompressedScope: (repoPath: string, anchorFileId: string) => Promise<{
        success: boolean
        markdown?: string
        fileName?: string
        error?: string
      }>
      onCodeMapFileModified: (callback: (data: { repoPath: string; relativePath: string }) => void) => () => void
      onCodeMapFileConfirmed: (callback: (data: { repoPath: string; relativePath: string }) => void) => () => void
      onCodeMapFileIndexed: (callback: (data: { repoPath: string; relativePath: string }) => void) => () => void

      // ─── Code Dash ───────────────────────────────────────────────────
      dashExecute: (input: string, repoPath: string) => Promise<DashExecutionResult>
    }
  }
}
