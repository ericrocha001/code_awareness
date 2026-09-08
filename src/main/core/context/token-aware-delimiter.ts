import { getCanonicalTokenizer, type TokenizerPort } from '../tokenizer'

export interface DelimiterBenchmark {
  name: string
  characters: number
  tokens: number
  samples: string[]
}

export interface SeparationBenchmark {
  tab: DelimiterBenchmark
  colon: DelimiterBenchmark
  pipe: DelimiterBenchmark
  comma: DelimiterBenchmark
  space: DelimiterBenchmark
}

export interface NestingBenchmark {
  newlines: DelimiterBenchmark
  braces: DelimiterBenchmark
  brackets: DelimiterBenchmark
  parentheses: DelimiterBenchmark
}

export interface RelationshipBenchmark {
  arrow: DelimiterBenchmark
  colon: DelimiterBenchmark
  bracket: DelimiterBenchmark
  brace: DelimiterBenchmark
}

export interface TokenAwareReport {
  fieldSeparation: SeparationBenchmark
  nesting: NestingBenchmark
  relationships: RelationshipBenchmark
  winners: {
    fieldSeparation: string
    nesting: string
    relationships: string
  }
}

const SAMPLE_PATH = 'src/features/auth/service.ts'
const SAMPLE_TOKENS = '612'
const SAMPLE_ID = 'a3'

function benchmarkDelimiter(name: string, samples: string[], tokenizer: TokenizerPort): DelimiterBenchmark {
  const content = samples.join('\n')
  return {
    name,
    characters: content.length,
    tokens: tokenizer.count(content),
    samples
  }
}

export function runTokenAwareDelimiterSearch(tokenizer: TokenizerPort = getCanonicalTokenizer()): TokenAwareReport {
  const fieldSepSamples = {
    tab: [
      `${SAMPLE_ID}\t${SAMPLE_TOKENS}\t${SAMPLE_PATH}`,
      `b1\t${SAMPLE_TOKENS}\tsrc/utils/helper.ts`
    ],
    colon: [
      `${SAMPLE_ID}:${SAMPLE_TOKENS}:${SAMPLE_PATH}`,
      `b1:${SAMPLE_TOKENS}:src/utils/helper.ts`
    ],
    pipe: [
      `${SAMPLE_ID}|${SAMPLE_TOKENS}|${SAMPLE_PATH}`,
      `b1|${SAMPLE_TOKENS}|src/utils/helper.ts`
    ],
    comma: [
      `${SAMPLE_ID},${SAMPLE_TOKENS},${SAMPLE_PATH}`,
      `b1,${SAMPLE_TOKENS},src/utils/helper.ts`
    ],
    space: [
      `${SAMPLE_ID} ${SAMPLE_TOKENS} ${SAMPLE_PATH}`,
      `b1 ${SAMPLE_TOKENS} src/utils/helper.ts`
    ]
  }

  const nestingSamples = {
    newlines: [
      'src/\n\ta.ts\n\tb.ts\n\tsub/\n\t\tc.ts',
      'src/\n\ta.ts\n\tb.ts'
    ],
    braces: [
      'src/{a.ts,b.ts,sub/{c.ts}}',
      'src/{a.ts,b.ts}'
    ],
    brackets: [
      'src/[a.ts,b.ts,sub/[c.ts]]',
      'src/[a.ts,b.ts]'
    ],
    parentheses: [
      'src/(a.ts,b.ts,sub/(c.ts))',
      'src/(a.ts,b.ts)'
    ]
  }

  const relationshipSamples = {
    arrow: [
      `${SAMPLE_ID}>b1,c2`,
      `a3>b1`
    ],
    colon: [
      `${SAMPLE_ID}:b1,c2`,
      `a3:b1`
    ],
    bracket: [
      `${SAMPLE_ID}[b1,c2]`,
      `a3[b1]`
    ],
    brace: [
      `${SAMPLE_ID}{b1,c2}`,
      `a3{b1}`
    ]
  }

  const fieldSeparation: SeparationBenchmark = {
    tab: benchmarkDelimiter('tab', fieldSepSamples.tab, tokenizer),
    colon: benchmarkDelimiter('colon', fieldSepSamples.colon, tokenizer),
    pipe: benchmarkDelimiter('pipe', fieldSepSamples.pipe, tokenizer),
    comma: benchmarkDelimiter('comma', fieldSepSamples.comma, tokenizer),
    space: benchmarkDelimiter('space', fieldSepSamples.space, tokenizer)
  }

  const nesting: NestingBenchmark = {
    newlines: benchmarkDelimiter('newlines', nestingSamples.newlines, tokenizer),
    braces: benchmarkDelimiter('braces', nestingSamples.braces, tokenizer),
    brackets: benchmarkDelimiter('brackets', nestingSamples.brackets, tokenizer),
    parentheses: benchmarkDelimiter('parentheses', nestingSamples.parentheses, tokenizer)
  }

  const relationships: RelationshipBenchmark = {
    arrow: benchmarkDelimiter('arrow', relationshipSamples.arrow, tokenizer),
    colon: benchmarkDelimiter('colon', relationshipSamples.colon, tokenizer),
    bracket: benchmarkDelimiter('bracket', relationshipSamples.bracket, tokenizer),
    brace: benchmarkDelimiter('brace', relationshipSamples.brace, tokenizer)
  }

  const findWinner = <T extends { tokens: number }>(benchmarks: Record<string, T>): string => {
    let winner = ''
    let minTokens = Infinity
    for (const [name, benchmark] of Object.entries(benchmarks)) {
      if (benchmark.tokens < minTokens) {
        minTokens = benchmark.tokens
        winner = name
      }
    }
    return winner
  }

  return {
    fieldSeparation,
    nesting,
    relationships,
    winners: {
      fieldSeparation: findWinner(fieldSeparation),
      nesting: findWinner(nesting),
      relationships: findWinner(relationships)
    }
  }
}

export function generateDelimiterReport(report: TokenAwareReport): string {
  const lines: string[] = []
  lines.push('# Token-Aware Delimiter Benchmark Report')
  lines.push('')
  lines.push('## Field Separation')
  lines.push('| Delimiter | Characters | Tokens |')
  lines.push('|-----------|------------|--------|')
  for (const [name, bench] of Object.entries(report.fieldSeparation)) {
    lines.push(`| ${name} | ${bench.characters} | ${bench.tokens} |`)
  }
  lines.push(`**Winner:** ${report.winners.fieldSeparation}`)
  lines.push('')
  lines.push('## Nesting')
  lines.push('| Delimiter | Characters | Tokens |')
  lines.push('|-----------|------------|--------|')
  for (const [name, bench] of Object.entries(report.nesting)) {
    lines.push(`| ${name} | ${bench.characters} | ${bench.tokens} |`)
  }
  lines.push(`**Winner:** ${report.winners.nesting}`)
  lines.push('')
  lines.push('## Relationships')
  lines.push('| Delimiter | Characters | Tokens |')
  lines.push('|-----------|------------|--------|')
  for (const [name, bench] of Object.entries(report.relationships)) {
    lines.push(`| ${name} | ${bench.characters} | ${bench.tokens} |`)
  }
  lines.push(`**Winner:** ${report.winners.relationships}`)
  return lines.join('\n')
}
