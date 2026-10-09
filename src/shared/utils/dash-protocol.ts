export const DASH_PROTOCOL_VERSION = 'code-dash/v2'
export const DASH_FIELDS = {
  'file-set': [
    'path',
    'language',
    'extension',
    'status',
    'lines',
    'bytes',
    'tokenCount',
    'contextReference',
    'fileSource'
  ],
  'element-set': [
    'target',
    'path',
    'name',
    'kind',
    'signature',
    'visibility',
    'modifiers',
    'returnType',
    'granularity',
    'lines',
    'bytes',
    'source'
  ],
  'reference-set': ['path', 'line', 'kind', 'sourceTarget']
} as const
