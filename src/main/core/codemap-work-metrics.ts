export function createCodeMapWorkMetrics() {
  return {
    filesVisited: 0, filesStatChecked: 0, contentReads: 0, hashesCalculated: 0,
    filesExtracted: 0, relationshipResolutions: 0, symbolSourcesResolved: 0, symbolRowsWritten: 0,
    metadataReused: 0, ignoreRuleReads: 0,
    phaseDurationMs: { discovery: 0, verification: 0, extraction: 0, relationships: 0, symbols: 0 }
  }
}

export type CodeMapWorkMetrics = ReturnType<typeof createCodeMapWorkMetrics>
