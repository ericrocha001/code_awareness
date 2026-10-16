const { execFileSync } = require('node:child_process')
exports.create = root => {
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim()
  const records = []
  let sequence = 0
  const commit = (day, subject, parents = [], files = 1) => {
    const mark = `:${++sequence}`
    const date = Math.floor(Date.now() / 1000 - (50 - day) * 86400)
    let record = `commit refs/heads/fixture-import\nmark ${mark}\ncommitter Proof Author <proof@example.com> ${date} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\n`
    parents.forEach((parent, index) => { record += `${index ? 'merge' : 'from'} ${parent}\n` })
    for (let index = 0; index < files; index++) {
      const content = `change ${sequence} file ${index}\n`
      record += `M 100644 inline source-${index}.ts\ndata ${Buffer.byteLength(content)}\n${content}`
    }
    records.push(record + '\n')
    return mark
  }
  const main = [commit(0, 'Initialize repository')]
  let work, academy, cli
  for (let day = 2; day <= 48; day += 2) {
    const parents = [main.at(-1)]
    if (day === 8) work = main.at(-1)
    if (day >= 8 && day <= 24) work = commit(day - .5, 'feat: refine work orchestration lifecycle', [work], 6)
    if (day === 26) parents.push(work)
    if (day === 28) academy = main.at(-1)
    if (day >= 28 && day <= 42) academy = commit(day - .5, 'fix: synchronize Academy materialization', [academy], 4)
    if (day === 44) parents.push(academy)
    if (day === 18) cli = main[3]
    if (day >= 18 && day <= 38 && day % 4 === 2) cli = commit(day - .25, 'feat: diagnose Windows profile discovery', [cli], 2)
    main.push(commit(day, day === 26 ? 'Merge work-orchestration: guarded worktree lifecycle' : day === 44 ? 'Merge academy-sync: synchronize local materialization' : 'feat: improve repository awareness', parents, 6))
  }
  records.push('reset refs/heads/fixture-import\n\n')
  const archived = commit(-30, 'Archived independent work')
  records.push('reset refs/heads/fixture-import\n\n')
  const archivedLater = commit(-20, 'Later independent work')
  for (const [name, mark] of [['main', main.at(-1)], ['work-orchestration', work], ['academy-sync', academy], ['local-cli-dlg', cli], ['zz-archived-independent-work-before-main', archived], ['zz-later-independent-work-before-main', archivedLater]]) records.push(`reset refs/heads/${name}\nfrom ${mark}\n\n`)
  for (const [name, mark] of [['v0.8.0', main[5]], ['v0.9.0', main[11]], ['v0.10.0', main[20]]]) records.push(`reset refs/tags/${name}\nfrom ${mark}\n\n`)
  execFileSync('git', ['fast-import', '--quiet'], { cwd: root, windowsHide: true, encoding: 'utf8', input: records.join('') })
  git('update-ref', '-d', 'refs/heads/fixture-import')
  git('reset', '--hard', 'main')
}
