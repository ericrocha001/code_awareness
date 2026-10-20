import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { GitBranch, GitCommitHorizontal, GitPullRequest, Search } from 'lucide-react'
import type { GitAtlasPage } from '../../../../shared/types/git-atlas-types'
import type { GitAtlasPrEvidence } from '../../../../shared/types/git-atlas-evidence-types'
import type { GitDecoration } from '../../../../shared/types/git-management-types'

export function AtlasSearch({ page, evidence, inspect, branch, pullRequest }: {
  page: GitAtlasPage | null; evidence: GitAtlasPrEvidence | null
  inspect: (sha: string) => void; branch: (ref: GitDecoration) => void; pullRequest: (number: number) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const resultsId = useId()
  const results = useMemo(() => {
    const value = query.trim().toLocaleLowerCase()
    const matches: Array<{ id: string; kind: 'BRANCH' | 'COMMIT' | 'PR'; label: string; choose: () => void }> = []
    if (!value) return matches
    for (const ref of page?.refs ?? []) {
      if (matches.length >= 12) break
      if (ref.kind !== 'HEAD' && ref.name.toLocaleLowerCase().includes(value)) matches.push({ id: ref.ref, kind: 'BRANCH', label: ref.name, choose: () => branch(ref) })
    }
    for (const node of page?.nodes ?? []) {
      if (matches.length >= 12) break
      if (`${node.sha} ${node.subject} ${node.author}`.toLocaleLowerCase().includes(value)) matches.push({ id: node.sha, kind: 'COMMIT', label: `${node.sha.slice(0, 8)} · ${node.subject}`, choose: () => inspect(node.sha) })
    }
    for (const pr of evidence?.pullRequests ?? []) {
      if (matches.length >= 12) break
      if (`#${pr.record.number} ${pr.record.title}`.toLocaleLowerCase().includes(value)) matches.push({ id: pr.record.id, kind: 'PR', label: `#${pr.record.number} · ${pr.record.title}`, choose: () => pullRequest(pr.record.number) })
    }
    return matches
  }, [query, page, evidence, inspect, branch, pullRequest])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || target instanceof Element && (target.closest('input,textarea,select') || target instanceof HTMLElement && target.isContentEditable)) return
      event.preventDefault(); input.current?.focus(); setOpen(true)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])
  const choose = (result: typeof results[number]) => { input.current?.focus(); result.choose(); setQuery(''); setOpen(false) }
  return <div className="gm-atlas-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }} onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); input.current?.focus(); event.stopPropagation() } }}>
    <Search size={17} aria-hidden="true" />
    <input ref={input} type="search" placeholder="Buscar commits, branches, PRs…" aria-label="Buscar no trecho e nos PRs carregados" aria-expanded={open && !!query.trim()} aria-controls={resultsId} value={query} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true) }} onKeyDown={event => {
      if (event.key === 'Escape') { setOpen(false); event.stopPropagation() }
      if (event.key === 'Enter' && results[0]) { event.preventDefault(); choose(results[0]) }
    }} />
    <kbd aria-hidden="true">/</kbd>
    {open && !!query.trim() && <div id={resultsId} className="gm-atlas-search-results" role="region" aria-label="Resultados da busca local">
      <small>Trecho e catálogo de PRs carregados · até 12 resultados</small>
      {results.map(result => <button key={`${result.kind}:${result.id}`} onClick={() => choose(result)}>{result.kind === 'BRANCH' ? <GitBranch size={15} /> : result.kind === 'PR' ? <GitPullRequest size={15} /> : <GitCommitHorizontal size={15} />}<span>{result.label}</span></button>)}
      {!results.length && <p role="status">Nenhum resultado no conteúdo carregado.</p>}
    </div>}
  </div>
}
