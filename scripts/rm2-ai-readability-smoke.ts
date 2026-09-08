import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../src/shared/types'
import { projectRM2, serializeRM2 } from '../src/main/core/context/rm2-encoder'

const files: CodeMapFile[] = [
  {
    id: 'auth-file', repositoryId: 'smoke', contextReference: 'a', relativePath: 'src/auth/service.ts',
    language: 'typescript', extension: '.ts', lines: 8, sizeBytes: 180, mtime: 1, contentHash: 'auth',
    tokenCount: 120, status: 'indexed'
  },
  {
    id: 'api-file', repositoryId: 'smoke', contextReference: 'b', relativePath: 'src/user/api.ts',
    language: 'typescript', extension: '.ts', lines: 5, sizeBytes: 100, mtime: 1, contentHash: 'api',
    tokenCount: 80, status: 'indexed'
  }
]

const position = (line: number, byte: number) => ({ line, column: 0, byte })
const elements: CodeMapElement[] = [
  {
    id: 'auth-class', repositoryId: 'smoke', fileId: 'auth-file', kind: 'class', name: 'AuthService',
    parentElementId: null, location: { start: position(1, 0), end: position(8, 180) }, sizeLines: 8,
    sizeBytes: 180, visibility: 'public', modifiers: ['export'], returnType: null, baseClass: null,
    hasDocumentation: false, parameterCount: 0, granularity: 'structural', retrievable: true
  },
  {
    id: 'validate-method', repositoryId: 'smoke', fileId: 'auth-file', kind: 'method', name: 'validate',
    parentElementId: 'auth-class', location: { start: position(2, 24), end: position(4, 110) }, sizeLines: 3,
    sizeBytes: 86, visibility: 'public', modifiers: [], returnType: 'boolean', baseClass: null,
    hasDocumentation: false, parameterCount: 1, granularity: 'structural', retrievable: true
  },
  {
    id: 'get-user', repositoryId: 'smoke', fileId: 'api-file', kind: 'function', name: 'getUser',
    parentElementId: null, location: { start: position(1, 0), end: position(5, 100) }, sizeLines: 5,
    sizeBytes: 100, visibility: null, modifiers: ['export'], returnType: 'User', baseClass: null,
    hasDocumentation: false, parameterCount: 1, granularity: 'structural', retrievable: true
  }
]

const relationships: CodeMapRelationship[] = [{
  id: 'api-auth', repositoryId: 'smoke', sourceId: 'api-file', targetId: 'auth-file',
  sourceKind: 'file', targetKind: 'file', type: 'imports'
}]

const snapshot = { projectName: 'Identity Console', files, elements, relationships }
const l2 = projectRM2(snapshot, 2)
console.log('--- RM2 L2 ---')
console.log(serializeRM2(l2))
console.log('\n--- QUESTIONS ---')
console.log([
  '1. What is the project name?',
  '2. What is the exact path and source token count of the authentication service?',
  '3. Which file does src/user/api.ts depend on?',
  '4. Which file has src/user/api.ts as an inbound dependent?',
  '5. Which files appear related to authentication?'
].join('\n'))
