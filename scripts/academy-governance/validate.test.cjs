const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { validateCommit } = require('./validate.cjs')

test('admits coherent commits and rejects identity, deletion and manifest violations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-governance-'))
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  const write = (file, text) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text) }
  const identity = { skillId: 'stable-alpha', path: 'skills/alpha', state: 'PRESENT' }
  const catalog = entries => write('.academy/identities.json', JSON.stringify({ schema: 2, skills: entries }))
  const commit = () => { git(['add', '--all']); git(['commit', '-m', 'fixture']); return git(['rev-parse', 'HEAD']).trim() }
  try {
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.com'])
    write('skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha\n---\n')
    catalog([identity])
    const base = commit()
    assert.equal(validateCommit(root).skills[0].skillId, identity.skillId)
    catalog([identity, { ...identity, path: 'skills/beta' }]); commit()
    assert.throws(() => validateCommit(root, 'HEAD', base), /ACADEMY_IDENTITY_COLLISION/)
    catalog([{ ...identity, path: 'skills/beta' }]); commit()
    assert.throws(() => validateCommit(root, 'HEAD', base), /ACADEMY_IDENTITY_TREE_MISMATCH/)
    fs.unlinkSync(path.join(root, 'skills/alpha/SKILL.md')); catalog([]); commit()
    assert.throws(() => validateCommit(root, 'HEAD', base), /ACADEMY_TOMBSTONE_REQUIRED/)
    catalog([{ ...identity, state: 'REMOVED', baseHash: 'a'.repeat(64), revision: 2 }]); commit()
    assert.equal(validateCommit(root, 'HEAD', base).skills[0].state, 'REMOVED')
    write('plugin.json', JSON.stringify({ name: 'foreign-plugin', version: '1.0.0' })); commit()
    assert.throws(() => validateCommit(root, 'HEAD', base), /OPENAI_PLUGIN_MANIFEST_UNAUTHORIZED/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
