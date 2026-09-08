/*
-T ---
*/

const EXTENSION_TO_DEVICON: Record<string, string> = {
  '.ts': 'devicon-typescript-plain',
  '.tsx': 'devicon-typescript-plain',
  '.js': 'devicon-javascript-plain',
  '.jsx': 'devicon-javascript-plain',
  '.py': 'devicon-python-plain',
  '.css': 'devicon-css3-plain',
  '.scss': 'devicon-sass-original',
  '.sass': 'devicon-sass-original',
  '.html': 'devicon-html5-plain',
  '.json': 'devicon-json-plain',
  '.md': 'devicon-markdown-original',
  '.mdx': 'devicon-markdown-original',
  '.yml': 'devicon-yaml-plain',
  '.yaml': 'devicon-yaml-plain',
  '.gitignore': 'devicon-git-plain',
  '.dockerfile': 'devicon-docker-plain',
  '.npmignore': 'devicon-npm-original-wordmark',
  '.env': 'devicon-dotenv-plain',
  '.go': 'devicon-go-original-wordmark',
  '.rs': 'devicon-rust-plain',
  '.rb': 'devicon-ruby-plain',
  '.java': 'devicon-java-plain',
  '.kt': 'devicon-kotlin-plain',
  '.swift': 'devicon-swift-plain',
  '.php': 'devicon-php-plain',
  '.c': 'devicon-c-plain',
  '.cpp': 'devicon-cplusplus-plain',
  '.h': 'devicon-c-plain',
  '.hpp': 'devicon-cplusplus-plain',
  '.cs': 'devicon-csharp-plain',
  '.sql': 'devicon-mysql-plain',
  '.sh': 'devicon-bash-plain',
  '.bash': 'devicon-bash-plain',
  '.zsh': 'devicon-bash-plain',
  '.ps1': 'devicon-powershell-plain',
  '.bat': 'devicon-windows11-original',
  '.cmd': 'devicon-windows11-original',
  '.vue': 'devicon-vuejs-plain',
  '.svelte': 'devicon-svelte-plain',
  '.astro': 'devicon-astro-plain',
  '.graphql': 'devicon-graphql-plain',
  '.gql': 'devicon-graphql-plain',
  '.svg': 'devicon-svg-plain',
  '.xml': 'devicon-xml-plain',
  '.yarn.lock': 'devicon-yarn-plain',
  '.lock': 'devicon-file-text',
  '.toml': 'devicon-toml-plain',
  '.cfg': 'devicon-file-text',
  '.conf': 'devicon-file-text',
  '.ini': 'devicon-file-text',
  '.editorconfig': 'devicon-editorconfig-plain',
  '.prettierrc': 'devicon-prettier-plain',
  '.eslintrc': 'devicon-eslint-plain',
  '.babelrc': 'devicon-babel-plain',
  '.gitattributes': 'devicon-git-plain',
  '.dockerignore': 'devicon-docker-plain',
  '.gradle': 'devicon-gradle-plain',
  '.vuepress': 'devicon-vuejs-plain',
  '.next.config': 'devicon-nextjs-original',
  '.nuxt.config': 'devicon-nuxtjs-plain',
}

const FALLBACK_CLASS = 'devicon-file-text'

/** Tipo nominal para classes CSS do Devicon — garante type safety na cadeia de renderização */
export type DeviconClass = (typeof EXTENSION_TO_DEVICON)[keyof typeof EXTENSION_TO_DEVICON] | typeof FALLBACK_CLASS

/**
 * Retorna a classe CSS do Devicon correspondente à extensão do arquivo.
 *
 * @param fileName - Nome do arquivo (ex.: "index.ts", "Dockerfile", "package.json")
 * @returns Classe CSS do Devicon (ex.: "devicon-typescript-plain")
 */
export function getFileIconClass(fileName: string): DeviconClass {
  if (!fileName) return FALLBACK_CLASS

  // Casos especiais: nome exato do arquivo
  const nameToIcon: Record<string, string> = {
    'dockerfile': 'devicon-docker-plain',
    'package.json': 'devicon-npm-original-wordmark',
    '.env': 'devicon-dotenv-plain',
    'makefile': 'devicon-file-text',
    'gemfile': 'devicon-ruby-plain',
    'procfile': 'devicon-file-text',
  }

  const lowerName = fileName.toLowerCase()
  const special = nameToIcon[lowerName]
  if (special) return special

  // Extrai a extensão (incluindo o ponto)
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex === -1) return FALLBACK_CLASS

  const ext = fileName.slice(dotIndex).toLowerCase()

  return EXTENSION_TO_DEVICON[ext] || FALLBACK_CLASS
}