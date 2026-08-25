/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Calcular cor de texto contrastante (getContrastColor) com base na luminância de uma cor hexadecimal.
2. Resolver paleta normalizada e segura de tag (resolveTagPalette) com fundo e texto de contraste garantido por tema (claro/escuro).
3. Fornecer funções puras, determinísticas e defensivas para uso em chips e componentes visuais.

Mapa de Relacionamentos do Script

1. TagChip.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome resolveTagPalette para colorir background e text do chip de tag.
   - Criticidade: Alta

2. CodeSourceView.tsx / CodeCompressionView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consomem getContrastColor para badges legados.
   - Criticidade: Baixa

Invariantes do Script

1. As funções são estritamente puras — para a mesma entrada e tema, produzem exatamente a mesma saída.
2. Nunca lançam exceção para entradas inválidas ou nulas — retornam paletas neutras seguras com contraste preservado.
3. A diferença de luminosidade entre background e text em resolveTagPalette é sempre superior a 0.60.

--- FIM ARQUITETURA DO SCRIPT ---
*/

export interface TagPalette {
  background: string
  text: string
}

/**
 * Retorna '#000' (preto) para cores claras ou '#fff' (branco) para cores escuras,
 * garantindo contraste adequado para texto sobre fundo colorido.
 */
export function getContrastColor(hexColor: string): string {
  if (!hexColor || typeof hexColor !== 'string' || hexColor.length < 4) return '#fff'

  try {
    const rgb = parseHex(hexColor)
    if (!rgb) return '#fff'

    // Fórmula de luminância relativa (W3C)
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255
    return luminance > 0.5 ? '#000' : '#fff'
  } catch {
    return '#fff'
  }
}

/**
 * Converte cor hex em componentes RGB normalizados (0-255).
 */
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  let cleaned = hex.trim().replace(/^#/, '')
  if (cleaned.length === 3) {
    cleaned = cleaned
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (cleaned.length !== 6) return null

  const r = parseInt(cleaned.slice(0, 2), 16)
  const g = parseInt(cleaned.slice(2, 4), 16)
  const b = parseInt(cleaned.slice(4, 6), 16)

  if (isNaN(r) || isNaN(g) || isNaN(b)) return null
  return { r, g, b }
}

/**
 * Converte RGB (0-255) em HSL (h: 0-1, s: 0-1, l: 0-1).
 */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rNorm = r / 255
  const gNorm = g / 255
  const bNorm = b / 255

  const max = Math.max(rNorm, gNorm, bNorm)
  const min = Math.min(rNorm, gNorm, bNorm)
  let h = 0
  let s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rNorm:
        h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)
        break
      case gNorm:
        h = (bNorm - rNorm) / d + 2
        break
      case bNorm:
        h = (rNorm - gNorm) / d + 4
        break
    }
    h /= 6
  }

  return { h, s, l }
}

/**
 * Converte HSL (h: 0-1, s: 0-1, l: 0-1) em Hex string (#rrggbb).
 */
function hslToHex(h: number, s: number, l: number): string {
  let r: number, g: number, b: number

  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      let temp = t
      if (temp < 0) temp += 1
      if (temp > 1) temp -= 1
      if (temp < 1 / 6) return p + (q - p) * 6 * temp
      if (temp < 1 / 2) return q
      if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6
      return p
    }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }

  const toHex = (x: number) => {
    const hex = Math.max(0, Math.min(255, Math.round(x * 255))).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

const NEUTRAL_PALETTES: Record<'light' | 'dark', TagPalette> = {
  light: { background: '#e2e8f0', text: '#1e293b' },
  dark: { background: '#1e293b', text: '#f1f5f9' }
}

/**
 * Resolve a paleta de cores (background e text) de uma tag para um determinado tema,
 * garantindo contraste por construção e evitando cores neon.
 */
export function resolveTagPalette(color: string, theme: 'light' | 'dark'): TagPalette {
  const safeTheme = theme === 'dark' ? 'dark' : 'light'

  if (!color || typeof color !== 'string') {
    return NEUTRAL_PALETTES[safeTheme]
  }

  const rgb = parseHex(color)
  if (!rgb) {
    return NEUTRAL_PALETTES[safeTheme]
  }

  const { h, s } = rgbToHsl(rgb.r, rgb.g, rgb.b)

  // Limita a saturação para no máximo 70% para evitar neon
  const safeS = Math.min(s, 0.70)

  if (safeTheme === 'light') {
    // Tema claro: fundo muito claro (88%), texto escuro (22%)
    const background = hslToHex(h, safeS, 0.88)
    const text = hslToHex(h, safeS, 0.22)
    return { background, text }
  } else {
    // Tema escuro: fundo escuro (18%), texto claro (88%)
    const background = hslToHex(h, safeS, 0.18)
    const text = hslToHex(h, safeS, 0.88)
    return { background, text }
  }
}