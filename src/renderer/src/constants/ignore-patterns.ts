// Responsabilidades do Script
//
// 1. Centralizar as definições de padrões de arquivos de ruído (NOISE_FILES) para o sistema de ignore.
//
// Fonte única de verdade: altere aqui para refletir em todos os componentes que usam ignore.

// Arquivos de ruído comuns que o botão "Varrer Mesa" ignora em massa
export const NOISE_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.DS_Store',
  'tsconfig.tsbuildinfo',
  'bun.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'composer.lock',
  'poetry.lock'
])

// Extensões comuns usadas pelo popup de ignore inteligente no CodeDiffView
export const COMMON_IGNORE_EXTENSIONS = new Set([
  '.css', '.scss', '.sass', '.less',
  '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
  '.md', '.txt', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.log', '.csv', '.xlsx', '.pdf', '.docx',
  '.eslintrc', '.prettierrc', '.babelrc', '.editorconfig'
])
