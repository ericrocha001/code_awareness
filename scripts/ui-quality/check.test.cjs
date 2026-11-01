const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { analyzeSource, checkFiles, registered } = require('./check.cjs')
const root = path.resolve(__dirname, '../..')
const fixture = name => `scripts/ui-quality/fixtures/${name}.tsx`
const analyze = text => analyzeSource(text, 'explicit.tsx')

test('known compliant fixture passes without inspecting historical feature paths', () => {
  const result = checkFiles([fixture('compliant')])
  assert.equal(result.errors, 0)
  assert.equal(result.review, 0)
  assert.deepEqual(result.files, [fixture('compliant')])
  assert.match(result.visual, /NOT_ASSESSED/)
  assert.ok(registered.every(file => file.includes('/shared/') || file.endsWith('ui-primitives-fixture.tsx')))
  assert.equal(checkFiles(registered).errors, 0)
})

test('typed violations fail with stable rule, file, line and cause', () => {
  const result = checkFiles([fixture('violating')])
  assert.equal(result.errors, 6)
  assert.deepEqual([...new Set(result.diagnostics.map(item => item.rule))].sort(), ['accessible-name', 'brand-is-not-state', 'canonical-control', 'field-label'])
  assert.ok(result.diagnostics.every(item => item.file === fixture('violating') && item.line > 0 && item.cause))
})

test('dynamic names and wrapper spreads are review evidence, not invented inaccessibility', () => {
  const result = analyze(`import { Button as Action } from './shared/Button/Button';
    const x = <><Action iconOnly aria-label={name} /><button {...props}><svg /></button><select id={id} /></>`)
  assert.equal(result.filter(item => item.category === 'ERROR').length, 0)
  assert.equal(result.filter(item => item.category === 'REVIEW').length, 3)
})

test('labelled, nested and compact controls plus long safety text are legitimate', () => {
  const result = analyze(`const x = <><button aria-labelledby="delete-name"><svg /></button>
    <label>Escolha<select><option>Local</option></select></label>
    <p>Não remova a confirmação de uma operação irreversível só para compactar a tela.</p></>`)
  assert.deepEqual(result, [])
})

test('children props and SVG naming are not falsely rejected as unnamed icons', () => {
  assert.deepEqual(analyze('const x = <button children="Salvar" />'), [])
  const result = analyze('const x = <button><svg><title>Adicionar</title></svg></button>')
  assert.equal(result.length, 1)
  assert.equal(result[0].category, 'REVIEW')
})

test('unrelated component names are not treated as shared wrappers', () => {
  assert.deepEqual(analyze(`import { Button } from './another-library'; const x = <Button size="tiny" />`), [])
})

test('brand tokens are identity; state misuse is an error; dynamic styling is review', () => {
  assert.deepEqual(analyze(`const x = <div style={{background:'var(--brand-blue)'}}>Marca</div>`), [])
  assert.equal(analyze(`const x = <div intent="danger" style={{color:'#6915B6'}}>Erro</div>`)[0].category, 'ERROR')
  assert.equal(analyze(`const x = <div data-ui-state="warning" style={computed}>Pendente</div>`)[0].category, 'REVIEW')
})

test('syntax errors and empty, missing, directory and out-of-checkout scopes fail explicitly', () => {
  assert.equal(analyze('const x = <button')[0].rule, 'syntax')
  assert.throws(() => checkFiles([]), /EMPTY_SCOPE/)
  assert.throws(() => checkFiles(['missing.tsx']))
  assert.throws(() => checkFiles(['scripts/ui-quality']))
  assert.throws(() => checkFiles(['../outside.tsx']))
})

test('CLI failures are nonzero, including ambiguous Git request and empty explicit selection', () => {
  for (const args of [['--file'], ['--changed'], ['--file', fixture('violating')]]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'check.cjs'), ...args], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 1)
    assert.match(result.stdout + result.stderr, /USAGE|accessible-name/)
  }
  const passed = spawnSync(process.execPath, [path.join(__dirname, 'check.cjs'), '--file', fixture('compliant')], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(passed.status, 0)
  assert.equal(JSON.parse(passed.stdout).status, 'MECHANICAL_PASS')
})
