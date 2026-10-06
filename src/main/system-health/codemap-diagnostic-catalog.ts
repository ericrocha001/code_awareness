/**
 * Catálogo canônico de fronteiras diagnósticas do CodeMap.
 *
 * Cada fronteira representa uma responsabilidade operacional cuja falha muda
 * materialmente onde investigar. Não mapeamos classes ou métodos — mapeamos
 * responsabilidades arquiteturais.
 *
 * Princípio:
 *   "Se eu soubesse que a falha ocorreu antes ou depois desta fronteira,
 *    minha investigação mudaria?" — se não, não é fronteira separada.
 *
 * Uso: monitoradores específicos consultam este catálogo para derivar
 * InvestigationTargets sem duplicar definições.
 */

import type { InvestigationTarget } from '../../shared/types/system-health-types'

// ─── Tipos do catálogo ────────────────────────────────────────────────────────

export type CodeMapDiagnosticArea =
  | 'Repository Lifecycle'
  | 'Repository Knowledge Acquisition'
  | 'Incremental Synchronization'
  | 'Repository Convergence'
  | 'Symbol Knowledge'
  | 'Background Maintenance'
  | 'Integrity'
  | 'Readiness'

/** Uma fronteira diagnóstica registrada no catálogo. */
export interface DiagnosticBoundary {
  /** Identidade estável — usada como chave e em mapeamentos de eventos. */
  readonly id: string
  /** Nome humano exibível. */
  readonly name: string
  /** Área arquitetural à qual pertence. */
  readonly area: CodeMapDiagnosticArea
  /** Fluxos nos quais esta fronteira participa. */
  readonly flows: readonly CodeMapDiagnosticFlow[]
  /** Investigation target para diagnóstico. */
  readonly target: InvestigationTarget
  /**
   * Eventos de telemetria que evidenciam atividade nesta fronteira.
   * Podem ser emitidos por múltiplos componentes.
   */
  readonly evidenceEvents: readonly string[]
  /**
   * Eventos de telemetria que sinalizam falha activa nesta fronteira.
   * Quando ausentes, gap de observabilidade deve ser declarado.
   */
  readonly errorEvents: readonly string[]
}

export type CodeMapDiagnosticFlow =
  | 'startup'
  | 'initial-indexing'
  | 'incremental-change'
  | 'integrity'
  | 'snapshot-maintenance'
  | 'readiness'
  | 'reconciliation'

// ─── Fronteiras por área ─────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// REPOSITORY LIFECYCLE
// ──────────────────────────────────────────────────────────────────────────────

const REPO_ACTIVATION: DiagnosticBoundary = {
  id: 'repo-activation',
  name: 'Repository Activation',
  area: 'Repository Lifecycle',
  flows: ['startup'],
  target: {
    systemArea: 'CodeMap Repository Lifecycle',
    component: 'CodeMapService / openRepository',
    boundary: 'Repository Path → Normalized Instance Entry',
    responsibility: 'Recognizing and normalizing the repository path, preventing duplicate opens, and initiating the instance assembly sequence',
    investigationSeeds: [
      'src/main/core/code-map-service.ts',
    ]
  },
  evidenceEvents: ['REPO_OPENED'],
  errorEvents: ['REPO_OPEN_FAILED'],
}

const REPO_STORE: DiagnosticBoundary = {
  id: 'repo-store',
  name: 'Repository Store',
  area: 'Repository Lifecycle',
  flows: ['startup'],
  target: {
    systemArea: 'CodeMap Repository Lifecycle',
    component: 'RepositoryDatabase / SQLite',
    boundary: 'Repository Path → Open Database Connection',
    responsibility: 'Opening the SQLite database, ensuring the schema is up-to-date, and loading the persisted repository identity',
    investigationSeeds: [
      'src/main/core/repository-database.ts',
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['REPO_OPENED'],
  errorEvents: ['REPO_OPEN_FAILED'],
}

const REPO_RUNTIME_COMPOSITION: DiagnosticBoundary = {
  id: 'repo-runtime-composition',
  name: 'Runtime Composition',
  area: 'Repository Lifecycle',
  flows: ['startup'],
  target: {
    systemArea: 'CodeMap Repository Lifecycle',
    component: 'CodeMapService / component assembly',
    boundary: 'Database Ready → Synchronizer + WatcherBridge Active',
    responsibility: 'Instantiating RepositoryFileMembership, RepositorySynchronizer, and WatcherBridge for the repository instance',
    investigationSeeds: [
      'src/main/core/code-map-service.ts',
      'src/main/core/repository-synchronizer.ts',
      'src/main/core/watcher-bridge.ts',
    ]
  },
  evidenceEvents: ['REPO_OPENED'],
  errorEvents: ['REPO_OPEN_FAILED'],
}

const REPO_DEACTIVATION: DiagnosticBoundary = {
  id: 'repo-deactivation',
  name: 'Repository Deactivation',
  area: 'Repository Lifecycle',
  flows: ['startup'],
  target: {
    systemArea: 'CodeMap Repository Lifecycle',
    component: 'CodeMapService / closeRepository',
    boundary: 'Close Request → Instance Removed',
    responsibility: 'Disposing the synchronizer, closing the database connection, and unsubscribing the watcher bridge',
    investigationSeeds: [
      'src/main/core/code-map-service.ts',
    ]
  },
  evidenceEvents: ['REPO_CLOSED'],
  errorEvents: [],
}

// ──────────────────────────────────────────────────────────────────────────────
// REPOSITORY KNOWLEDGE ACQUISITION
// ──────────────────────────────────────────────────────────────────────────────

const MEMBERSHIP_CLASSIFICATION: DiagnosticBoundary = {
  id: 'membership-classification',
  name: 'Membership Classification',
  area: 'Repository Knowledge Acquisition',
  flows: ['initial-indexing', 'reconciliation'],
  target: {
    systemArea: 'CodeMap Membership',
    component: 'RepositoryFileMembership',
    boundary: 'Candidate Paths → Eligible / Ignored / Ineligible',
    responsibility: 'Classifying scanned or event-driven paths as eligible for indexing using Git semantics (nested .gitignore, excludes) or filesystem policy',
    investigationSeeds: [
      'src/main/core/repository-file-membership.ts',
      'src/main/core/git-service.ts',
    ]
  },
  evidenceEvents: ['INDEX_SCANNED', 'INTAKE_ACCEPTED', 'INTAKE_REJECTED'],
  errorEvents: [],
}

const SOURCE_READ: DiagnosticBoundary = {
  id: 'source-read',
  name: 'Source Read',
  area: 'Repository Knowledge Acquisition',
  flows: ['initial-indexing', 'incremental-change'],
  target: {
    systemArea: 'CodeMap Structural Index',
    component: 'RepositoryModel / file content access',
    boundary: 'Eligible Path → Source Content Available',
    responsibility: 'Reading file content from disk, detecting binary content, and preparing source for structural extraction',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
      'src/main/core/repository-scanner.ts',
    ]
  },
  evidenceEvents: ['REINDEX_STARTED', 'HASH_CALCULATED'],
  errorEvents: ['REINDEX_FAILED'],
}

const STRUCTURE_EXTRACTION: DiagnosticBoundary = {
  id: 'structure-extraction',
  name: 'Structure Extraction',
  area: 'Repository Knowledge Acquisition',
  flows: ['initial-indexing', 'incremental-change'],
  target: {
    systemArea: 'CodeMap Structural Index',
    component: 'StructureExtractor / language-specific parser',
    boundary: 'Source Content → Structural Elements + Relationships',
    responsibility: 'Parsing source content into elements (classes, functions, imports, etc.), relationships, and interface bindings using a language-specific extractor or text document fallback',
    investigationSeeds: [
      'src/main/core/extraction/',
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['STRUCTURE_EXTRACTED'],
  errorEvents: ['STRUCTURE_EXTRACTION_FAILED'],
}

const STRUCTURAL_PERSISTENCE: DiagnosticBoundary = {
  id: 'structural-persistence',
  name: 'Structural Persistence',
  area: 'Repository Knowledge Acquisition',
  flows: ['initial-indexing', 'incremental-change'],
  target: {
    systemArea: 'CodeMap Structural Index',
    component: 'RepositoryDatabase / replaceIndexedFileState',
    boundary: 'Extracted Structure → Persisted Canonical State',
    responsibility: 'Atomically persisting file record, elements, intra-file relationships, and interface bindings to the repository database in a single transaction',
    investigationSeeds: [
      'src/main/core/repository-database.ts',
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['STRUCTURAL_PERSISTENCE_COMPLETED'],
  errorEvents: ['REINDEX_FAILED'],
}

const RELATIONSHIP_RESOLUTION: DiagnosticBoundary = {
  id: 'relationship-resolution',
  name: 'Relationship Resolution',
  area: 'Repository Knowledge Acquisition',
  flows: ['initial-indexing', 'incremental-change'],
  target: {
    systemArea: 'CodeMap Relationship Graph',
    component: 'RepositoryModel / RelationshipResolver',
    boundary: 'Full Element Set → Cross-file Relationship Edges',
    responsibility: 'Computing import, extends, and implements edges across all files in the repository using the current element set',
    investigationSeeds: [
      'src/main/core/relationship-resolver.ts',
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['RELATIONSHIP_RESOLUTION_STARTED', 'RELATIONSHIP_RESOLUTION_COMPLETED'],
  errorEvents: ['RELATIONSHIP_RESOLUTION_FAILED'],
}

const RELATIONSHIP_PERSISTENCE: DiagnosticBoundary = {
  id: 'relationship-persistence',
  name: 'Relationship Persistence',
  area: 'Repository Knowledge Acquisition',
  flows: ['initial-indexing', 'incremental-change'],
  target: {
    systemArea: 'CodeMap Relationship Graph',
    component: 'RepositoryDatabase / saveRelationships',
    boundary: 'Resolved Relationship Edges → Persisted Graph',
    responsibility: 'Writing the resolved cross-file relationship edges to the database, replacing the previous graph state',
    investigationSeeds: [
      'src/main/core/repository-database.ts',
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['RELATIONSHIP_RESOLUTION_COMPLETED'],
  errorEvents: ['RELATIONSHIP_RESOLUTION_FAILED'],
}

// ──────────────────────────────────────────────────────────────────────────────
// INCREMENTAL SYNCHRONIZATION (preserva fronteiras já existentes no sync monitor)
// ──────────────────────────────────────────────────────────────────────────────

const REPO_OBSERVATION: DiagnosticBoundary = {
  id: 'repo-observation',
  name: 'Repository Observation',
  area: 'Incremental Synchronization',
  flows: ['incremental-change'],
  target: {
    systemArea: 'CodeMap Filesystem Observation',
    component: 'WatcherService / WatcherBridge',
    boundary: 'Filesystem → RepositoryEventBus',
    responsibility: 'Observing filesystem changes and delivering path notifications to the event bus with correlation IDs',
    investigationSeeds: [
      'src/main/core/watcher-service.ts',
      'src/main/core/watcher-bridge.ts',
    ]
  },
  evidenceEvents: ['EVENT_BRIDGED', 'OBSERVED', 'QUEUED'],
  errorEvents: [],
}

const PATH_ELIGIBILITY: DiagnosticBoundary = {
  id: 'path-eligibility',
  name: 'Path Eligibility',
  area: 'Incremental Synchronization',
  flows: ['incremental-change'],
  target: {
    systemArea: 'CodeMap Change Intake Gate',
    component: 'RepositoryFileMembership',
    boundary: 'RepositoryEventBus → RepositorySynchronizer intake',
    responsibility: 'Classifying incoming paths as eligible, ignored, directory, or ineligible before expensive work',
    investigationSeeds: [
      'src/main/core/repository-file-membership.ts',
      'src/main/core/repository-synchronizer.ts',
    ]
  },
  evidenceEvents: ['INTAKE_ACCEPTED', 'INTAKE_REJECTED'],
  errorEvents: [],
}

const CHANGE_INTAKE: DiagnosticBoundary = {
  id: 'change-intake',
  name: 'Change Intake',
  area: 'Incremental Synchronization',
  flows: ['incremental-change'],
  target: {
    systemArea: 'CodeMap Change Queue',
    component: 'RepositorySynchronizer / Debounce Queue',
    boundary: 'Path Eligibility → Stabilization',
    responsibility: 'Enqueuing accepted paths and coalescing burst events before stabilization',
    investigationSeeds: [
      'src/main/core/repository-synchronizer.ts',
    ]
  },
  evidenceEvents: ['INTAKE_ACCEPTED', 'QUEUE_PROCESSING'],
  errorEvents: ['VERIFY_FAILED'],
}

const CHANGE_STABILIZATION: DiagnosticBoundary = {
  id: 'change-stabilization',
  name: 'Change Stabilization',
  area: 'Incremental Synchronization',
  flows: ['incremental-change'],
  target: {
    systemArea: 'CodeMap Change Verification',
    component: 'RepositorySynchronizer / Stabilization',
    boundary: 'Change Intake → Hash Verification',
    responsibility: 'Waiting for file writes to complete via stat consistency check before reading content',
    investigationSeeds: [
      'src/main/core/repository-synchronizer.ts',
    ]
  },
  evidenceEvents: ['STABILIZE_CHECK', 'RESTABILIZE_SCHEDULED'],
  errorEvents: ['CONFIRMED_UNSTABLE'],
}

const CHANGE_VERIFICATION: DiagnosticBoundary = {
  id: 'change-verification',
  name: 'Change Verification',
  area: 'Incremental Synchronization',
  flows: ['incremental-change'],
  target: {
    systemArea: 'CodeMap Content Verification',
    component: 'RepositorySynchronizer / Hash Check',
    boundary: 'Stabilization → Reindex Decision',
    responsibility: 'Comparing disk content hash against indexed hash to confirm real change',
    investigationSeeds: [
      'src/main/core/repository-synchronizer.ts',
    ]
  },
  evidenceEvents: ['HASH_CALCULATED', 'CONFIRMED_MODIFIED', 'CONFIRMED_NEW', 'CONFIRMED_DELETED'],
  errorEvents: ['VERIFY_FAILED'],
}

const FILE_REINDEX: DiagnosticBoundary = {
  id: 'file-reindex',
  name: 'File Reindex',
  area: 'Incremental Synchronization',
  flows: ['incremental-change'],
  target: {
    systemArea: 'CodeMap File Reindex',
    component: 'RepositoryModel / updateFileContent',
    boundary: 'Verification → CodeMap Updated',
    responsibility: 'Parsing and indexing file content, elements, and relationships into the repository model',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
      'src/main/core/repository-synchronizer.ts',
    ]
  },
  evidenceEvents: ['REINDEX_STARTED', 'REINDEX_COMPLETED', 'AUTO_REINDEX_COMPLETED'],
  errorEvents: ['REINDEX_FAILED', 'AUTO_REINDEX_FAILED', 'SYNC_BATCH_FAILED'],
}

// ──────────────────────────────────────────────────────────────────────────────
// REPOSITORY CONVERGENCE
// ──────────────────────────────────────────────────────────────────────────────

const DISK_BANK_RECONCILIATION: DiagnosticBoundary = {
  id: 'disk-bank-reconciliation',
  name: 'Disk/Bank Reconciliation',
  area: 'Repository Convergence',
  flows: ['startup', 'reconciliation'],
  target: {
    systemArea: 'CodeMap Repository Convergence',
    component: 'RepositoryModel / reconcileWithDisk',
    boundary: 'Known Index State → Disk Reality Verified',
    responsibility: 'Comparing the current database state against the filesystem to detect moved, deleted, modified, and new files since the last session',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['RECONCILE_STARTED', 'RECONCILE_COMPLETED'],
  errorEvents: ['RECONCILE_FAILED'],
}

const CONVERGENCE_REPAIR: DiagnosticBoundary = {
  id: 'convergence-repair',
  name: 'Convergence Repair',
  area: 'Repository Convergence',
  flows: ['reconciliation'],
  target: {
    systemArea: 'CodeMap Repository Convergence',
    component: 'RepositoryModel / indexUnexpected',
    boundary: 'Detected Difference → Index Updated',
    responsibility: 'Indexing newly discovered files and handling moved files during reconciliation to bring the index into agreement with disk state',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['RECONCILE_UNEXPECTED_INDEXED'],
  errorEvents: ['RECONCILE_FAILED'],
}

// ──────────────────────────────────────────────────────────────────────────────
// SYMBOL KNOWLEDGE
// ──────────────────────────────────────────────────────────────────────────────

const SYMBOL_REF_RESOLUTION: DiagnosticBoundary = {
  id: 'symbol-ref-resolution',
  name: 'Symbol Reference Resolution',
  area: 'Symbol Knowledge',
  flows: ['initial-indexing', 'snapshot-maintenance', 'incremental-change'],
  target: {
    systemArea: 'CodeMap Symbol Knowledge',
    component: 'RepositoryModel / resolveSymbolReferences',
    boundary: 'Structural Elements → Cross-file Symbol Usage Graph',
    responsibility: 'Resolving call, instantiation, type, and reference usages of symbols across files using import binding analysis',
    investigationSeeds: [
      'src/main/core/symbol-reference-resolver.ts',
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['BACKFILL_SYMBOL_REFERENCES_STARTED', 'BACKFILL_SYMBOL_REFERENCES_COMPLETED', 'SYMBOL_REFERENCE_RESOLUTION_STARTED', 'SYMBOL_REFERENCE_RESOLUTION_COMPLETED'],
  errorEvents: ['BACKFILL_SYMBOL_REFERENCES_FAILED', 'SYMBOL_REFERENCE_RESOLUTION_FAILED'],
}

const SYMBOL_REF_PERSISTENCE: DiagnosticBoundary = {
  id: 'symbol-ref-persistence',
  name: 'Symbol Reference Persistence',
  area: 'Symbol Knowledge',
  flows: ['initial-indexing', 'snapshot-maintenance', 'incremental-change'],
  target: {
    systemArea: 'CodeMap Symbol Knowledge',
    component: 'RepositoryDatabase / replaceSymbolReferencesForFile',
    boundary: 'Resolved Symbol Usages → Persisted Reference Graph',
    responsibility: 'Writing per-file symbol reference records to the database, replacing previous references for affected files',
    investigationSeeds: [
      'src/main/core/repository-database.ts',
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['BACKFILL_SYMBOL_REFERENCES_COMPLETED', 'SYMBOL_REFERENCE_PERSISTENCE_COMPLETED'],
  errorEvents: ['BACKFILL_SYMBOL_REFERENCES_FAILED', 'SYMBOL_REFERENCE_PERSISTENCE_FAILED'],
}

// ──────────────────────────────────────────────────────────────────────────────
// BACKGROUND MAINTENANCE
// ──────────────────────────────────────────────────────────────────────────────

const MAINTENANCE_CONTENT_IDENTITY: DiagnosticBoundary = {
  id: 'maintenance-content-identity',
  name: 'Content Identity Backfill',
  area: 'Background Maintenance',
  flows: ['snapshot-maintenance'],
  target: {
    systemArea: 'CodeMap Background Maintenance',
    component: 'RepositoryModel / backfillContentHashes',
    boundary: 'Legacy Files Without Hash → Content Hash Available',
    responsibility: 'Computing SHA-256 content hashes for legacy indexed files that pre-date the hash-based change detection mechanism',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['BACKFILL_STARTED', 'BACKFILL_COMPLETED'],
  errorEvents: ['BACKFILL_FAILED'],
}

const MAINTENANCE_CONTEXT_REF: DiagnosticBoundary = {
  id: 'maintenance-context-ref',
  name: 'Context Reference Backfill',
  area: 'Background Maintenance',
  flows: ['snapshot-maintenance'],
  target: {
    systemArea: 'CodeMap Background Maintenance',
    component: 'RepositoryDatabase / backfillContextReferences',
    boundary: 'Files Without Context Reference → Context Reference Assigned',
    responsibility: 'Assigning stable context reference IDs to legacy file records that lack them',
    investigationSeeds: [
      'src/main/core/repository-database.ts',
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['MAINTENANCE_CONTEXT_REF_STARTED', 'MAINTENANCE_CONTEXT_REF_COMPLETED'],
  errorEvents: ['MAINTENANCE_CONTEXT_REF_FAILED'],
}

const MAINTENANCE_TOKEN_METADATA: DiagnosticBoundary = {
  id: 'maintenance-token-metadata',
  name: 'Token Metadata Backfill',
  area: 'Background Maintenance',
  flows: ['snapshot-maintenance'],
  target: {
    systemArea: 'CodeMap Background Maintenance',
    component: 'RepositoryModel / backfillTokenMetadata',
    boundary: 'Files Without Token Count → Token Metadata Available',
    responsibility: 'Computing token counts and tokenizer metadata for indexed files, enabling compression and context budgeting',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
      'src/main/core/tokenizer.ts',
    ]
  },
  evidenceEvents: ['MAINTENANCE_TOKEN_METADATA_STARTED', 'MAINTENANCE_TOKEN_METADATA_COMPLETED'],
  errorEvents: ['MAINTENANCE_TOKEN_METADATA_FAILED'],
}

const MAINTENANCE_TEXT_DOCUMENTS: DiagnosticBoundary = {
  id: 'maintenance-text-documents',
  name: 'Text Document Backfill',
  area: 'Background Maintenance',
  flows: ['snapshot-maintenance'],
  target: {
    systemArea: 'CodeMap Background Maintenance',
    component: 'RepositoryModel / backfillTextDocuments',
    boundary: 'Markdown/JSON Files Without Section Elements → Document Structure Available',
    responsibility: 'Re-indexing markdown and JSON files to produce section and document elements when they were previously indexed without structural extraction',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
      'src/main/core/extraction/markdown-extractor.ts',
      'src/main/core/extraction/json-extractor.ts',
    ]
  },
  evidenceEvents: ['MAINTENANCE_TEXT_DOCUMENTS_STARTED', 'MAINTENANCE_TEXT_DOCUMENTS_COMPLETED'],
  errorEvents: ['MAINTENANCE_TEXT_DOCUMENTS_FAILED'],
}

const MAINTENANCE_DECLARATION_SIGS: DiagnosticBoundary = {
  id: 'maintenance-declaration-sigs',
  name: 'Declaration Signature Backfill',
  area: 'Background Maintenance',
  flows: ['snapshot-maintenance'],
  target: {
    systemArea: 'CodeMap Background Maintenance',
    component: 'RepositoryModel / backfillDeclarationSignatures',
    boundary: 'Elements Without Declaration Signature → Signature Available',
    responsibility: 'Filling in null declarationSignature fields for function, method, and class elements that were indexed before signature extraction was available',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['MAINTENANCE_DECLARATION_SIGS_STARTED', 'MAINTENANCE_DECLARATION_SIGS_COMPLETED'],
  errorEvents: ['MAINTENANCE_DECLARATION_SIGS_FAILED'],
}

const MAINTENANCE_SYMBOL_REFS: DiagnosticBoundary = {
  id: 'maintenance-symbol-refs',
  name: 'Symbol Reference Backfill',
  area: 'Background Maintenance',
  flows: ['snapshot-maintenance'],
  target: {
    systemArea: 'CodeMap Background Maintenance',
    component: 'RepositoryModel / backfillSymbolReferences',
    boundary: 'All Files → Complete Symbol Reference Graph',
    responsibility: 'Building the full cross-file symbol usage graph for all files in the repository, required for get_references and get_symbol_dependencies',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
      'src/main/core/symbol-reference-resolver.ts',
    ]
  },
  evidenceEvents: ['BACKFILL_SYMBOL_REFERENCES_STARTED', 'BACKFILL_SYMBOL_REFERENCES_COMPLETED', 'SYMBOL_REFERENCE_RESOLUTION_STARTED', 'SYMBOL_REFERENCE_RESOLUTION_COMPLETED'],
  errorEvents: ['BACKFILL_SYMBOL_REFERENCES_FAILED'],
}

// ──────────────────────────────────────────────────────────────────────────────
// INTEGRITY
// ──────────────────────────────────────────────────────────────────────────────

const INTEGRITY_DISCOVERY: DiagnosticBoundary = {
  id: 'integrity-discovery',
  name: 'Integrity Discovery',
  area: 'Integrity',
  flows: ['integrity'],
  target: {
    systemArea: 'CodeMap Integrity',
    component: 'RepositoryModel / discoverIntegrityIssues',
    boundary: 'Current Index State → Classified Inconsistency List',
    responsibility: 'Scanning the index against the disk and database to classify hash mismatches, missing files, unexpected files, orphan elements, and invalid relationships',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: [
    'CHECK_STARTED',
    'FILES_CHECK_COMPLETED',
    'UNEXPECTED_CHECK_COMPLETED',
    'ELEMENTS_CHECK_COMPLETED',
    'RELATIONSHIPS_CHECK_COMPLETED',
    'DISCOVERY_COMPLETED',
  ],
  errorEvents: [],
}

const INTEGRITY_REPAIR: DiagnosticBoundary = {
  id: 'integrity-repair',
  name: 'Integrity Repair',
  area: 'Integrity',
  flows: ['integrity'],
  target: {
    systemArea: 'CodeMap Integrity',
    component: 'RepositoryModel / repairIntegrityIssues',
    boundary: 'Classified Issues → Repaired Index State',
    responsibility: 'Executing targeted repairs for discovered inconsistencies: reindexing divergent files, removing orphan elements and invalid relationships',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['REPAIR_STARTED', 'REPAIR_COMPLETED'],
  errorEvents: [],
}

const INTEGRITY_VERIFICATION: DiagnosticBoundary = {
  id: 'integrity-verification',
  name: 'Integrity Verification',
  area: 'Integrity',
  flows: ['integrity'],
  target: {
    systemArea: 'CodeMap Integrity',
    component: 'RepositoryModel / verifyIntegrity (revalidation)',
    boundary: 'Post-Repair State → Convergence Confirmed',
    responsibility: 'Re-running issue discovery after repair to confirm that the repaired state satisfies the integrity contract',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
    ]
  },
  evidenceEvents: ['REVALIDATION_COMPLETED', 'CHECK_COMPLETED'],
  errorEvents: [],
}

// ──────────────────────────────────────────────────────────────────────────────
// READINESS
// ──────────────────────────────────────────────────────────────────────────────

const READINESS_FILE_INVENTORY: DiagnosticBoundary = {
  id: 'readiness-file-inventory',
  name: 'FILE_INVENTORY Readiness',
  area: 'Readiness',
  flows: ['readiness'],
  target: {
    systemArea: 'CodeMap Readiness',
    component: 'CodeMapService / awaitReadiness(FILE_INVENTORY)',
    boundary: 'Repository Open → File List Available',
    responsibility: 'Ensuring the repository instance is open and the file inventory can be served immediately from the current persisted state',
    investigationSeeds: [
      'src/main/core/code-map-service.ts',
    ]
  },
  evidenceEvents: ['REPO_OPENED'],
  errorEvents: ['REPO_OPEN_FAILED'],
}

const READINESS_STRUCTURE: DiagnosticBoundary = {
  id: 'readiness-structure',
  name: 'STRUCTURE Readiness',
  area: 'Readiness',
  flows: ['readiness'],
  target: {
    systemArea: 'CodeMap Readiness',
    component: 'CodeMapService / awaitReadiness(STRUCTURE)',
    boundary: 'Accepted Changes → Structural Persistence',
    responsibility: 'Waiting for changes captured by the causal barrier to persist structural state, independently of relationships, symbols and global maintenance',
    investigationSeeds: [
      'src/main/core/code-map-service.ts',
    ]
  },
  evidenceEvents: ['STRUCTURAL_PERSISTENCE_COMPLETED'],
  errorEvents: ['REINDEX_FAILED'],
}

const READINESS_RELATIONSHIPS: DiagnosticBoundary = {
  id: 'readiness-relationships',
  name: 'RELATIONSHIPS Readiness',
  area: 'Readiness',
  flows: ['readiness', 'incremental-change'],
  target: {
    systemArea: 'CodeMap Readiness',
    component: 'CodeMapService / awaitReadiness(RELATIONSHIPS)',
    boundary: 'Captured Changes → Relationship Persistence',
    responsibility: 'Waiting for captured changes to persist consistent relationships, independently of later symbol enrichment, maintenance and future changes',
    investigationSeeds: [
      'src/main/core/code-map-service.ts',
      'src/main/core/repository-synchronizer.ts',
    ]
  },
  evidenceEvents: ['RELATIONSHIP_RESOLUTION_COMPLETED'],
  errorEvents: ['RELATIONSHIP_RESOLUTION_FAILED'],
}

const READINESS_SYMBOL_REFERENCES: DiagnosticBoundary = {
  id: 'readiness-symbol-references',
  name: 'SYMBOL_REFERENCES Readiness',
  area: 'Readiness',
  flows: ['readiness', 'incremental-change'],
  target: {
    systemArea: 'CodeMap Readiness',
    component: 'CodeMapService / awaitReadiness(SYMBOL_REFERENCES)',
    boundary: 'Captured Changes → Affected Symbol Reference Persistence',
    responsibility: 'Waiting for affected sources of captured changes to resolve and persist their symbol references without waiting for unrelated maintenance or future changes',
    investigationSeeds: ['src/main/core/code-map-service.ts', 'src/main/core/repository-change-readiness.ts', 'src/main/core/repository-model.ts']
  },
  evidenceEvents: ['SYMBOL_REFERENCE_PERSISTENCE_COMPLETED'],
  errorEvents: ['SYMBOL_REFERENCE_RESOLUTION_FAILED', 'SYMBOL_REFERENCE_PERSISTENCE_FAILED']
}

const READINESS_SNAPSHOT: DiagnosticBoundary = {
  id: 'readiness-snapshot',
  name: 'Snapshot Readiness',
  area: 'Readiness',
  flows: ['readiness', 'snapshot-maintenance'],
  target: {
    systemArea: 'CodeMap Readiness',
    component: 'CodeMapService / awaitSnapshot',
    boundary: 'Background Maintenance Complete + Synchronizer Idle → Snapshot Ready',
    responsibility: 'Waiting for the full background maintenance chain (all backfills and reconcile) and synchronizer idle state before serving operations that require complete symbol knowledge',
    investigationSeeds: [
      'src/main/core/code-map-service.ts',
    ]
  },
  evidenceEvents: ['BACKGROUND_MAINTENANCE_COMPLETED'],
  errorEvents: ['BACKGROUND_MAINTENANCE_FAILED'],
}

// ─── Catálogo master ──────────────────────────────────────────────────────────

export const CODEMAP_DIAGNOSTIC_CATALOG: readonly DiagnosticBoundary[] = [
  // Repository Lifecycle
  REPO_ACTIVATION,
  REPO_STORE,
  REPO_RUNTIME_COMPOSITION,
  REPO_DEACTIVATION,
  // Repository Knowledge Acquisition
  MEMBERSHIP_CLASSIFICATION,
  SOURCE_READ,
  STRUCTURE_EXTRACTION,
  STRUCTURAL_PERSISTENCE,
  RELATIONSHIP_RESOLUTION,
  RELATIONSHIP_PERSISTENCE,
  // Incremental Synchronization
  REPO_OBSERVATION,
  PATH_ELIGIBILITY,
  CHANGE_INTAKE,
  CHANGE_STABILIZATION,
  CHANGE_VERIFICATION,
  FILE_REINDEX,
  // Repository Convergence
  DISK_BANK_RECONCILIATION,
  CONVERGENCE_REPAIR,
  // Symbol Knowledge
  SYMBOL_REF_RESOLUTION,
  SYMBOL_REF_PERSISTENCE,
  // Background Maintenance
  MAINTENANCE_CONTENT_IDENTITY,
  MAINTENANCE_CONTEXT_REF,
  MAINTENANCE_TOKEN_METADATA,
  MAINTENANCE_TEXT_DOCUMENTS,
  MAINTENANCE_DECLARATION_SIGS,
  MAINTENANCE_SYMBOL_REFS,
  // Integrity
  INTEGRITY_DISCOVERY,
  INTEGRITY_REPAIR,
  INTEGRITY_VERIFICATION,
  // Readiness
  READINESS_FILE_INVENTORY,
  READINESS_STRUCTURE,
  READINESS_RELATIONSHIPS,
  READINESS_SYMBOL_REFERENCES,
  READINESS_SNAPSHOT,
] as const

/** Lookup por ID estável. */
export const BOUNDARY_BY_ID = new Map<string, DiagnosticBoundary>(
  CODEMAP_DIAGNOSTIC_CATALOG.map(b => [b.id, b])
)

/** Todas as fronteiras de uma área específica. */
export function boundariesByArea(area: CodeMapDiagnosticArea): DiagnosticBoundary[] {
  return CODEMAP_DIAGNOSTIC_CATALOG.filter(b => b.area === area)
}

/** Todas as fronteiras que participam de um fluxo específico. */
export function boundariesByFlow(flow: CodeMapDiagnosticFlow): DiagnosticBoundary[] {
  return CODEMAP_DIAGNOSTIC_CATALOG.filter(b => b.flows.includes(flow))
}
