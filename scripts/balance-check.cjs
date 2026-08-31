const { execSync } = require('child_process')
const fs = require('fs')
const lines = fs.readFileSync('src/main/core/one-click-xml-acceptance.test.ts', 'utf-8').split('\n')
const closers = []
lines.forEach((l, i) => { if (/^  \)\s*$/.test(l)) closers.push(i + 1) })
for (const n of closers) {
  const content = lines.slice(0, n).join('\n') + '\n})\n'
  fs.writeFileSync('scripts/bisect-tmp.ts', content)
  try {
    execSync('npx esbuild scripts/bisect-tmp.ts --loader:.ts=ts --outfile=NUL 2>&1', { stdio: 'pipe' })
    console.log(`OK ate linha ${n}`)
  } catch (e) {
    console.log(`FALHA ao fechar na linha ${n}`)
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '')
    console.log(out.split('\n').filter(x => x.includes('ERROR') || x.includes('│')).slice(0, 6).join('\n'))
    break
  }
}
