/*
-T ---
*/

export interface FileListingPort {
  listAllFiles(repoPath: string): Promise<Array<{ relativePath: string }>>
}
