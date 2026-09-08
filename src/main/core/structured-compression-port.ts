/*
-T ---
*/

import type { CompressionProfile, OutputFormat } from '../../shared/types'

export interface StructuredCompressionResult {
  results: Record<string, string>
  errors: string[]
  errorReasons: Record<string, string>
}

export interface StructuredCompressionPort {
  compressFilesStructured(
    repoPath: string,
    selectedFiles: string[],
    profile?: CompressionProfile,
    outputFormat?: OutputFormat
  ): Promise<StructuredCompressionResult>
}
