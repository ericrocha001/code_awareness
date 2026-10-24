import React, { useEffect, useRef, useState } from 'react'
import { ChevronsDownUp, ChevronsUpDown, RotateCcw, SlidersHorizontal, X } from 'lucide-react'
import type { ContinuumFacet, ContinuumPeriod, ContinuumScalar } from '../../../../shared/types/continuum-ui-types'

const defaults = ['kind', 'status', 'date', 'feature']
const preferenceKey = (repositoryId: string) => `continuum:visible-facets:${repositoryId}`

function readPreference(repositoryId: string): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey(repositoryId)) ?? 'null')
    return Array.isArray(value) && value.every(key => typeof key === 'string') ? value : null
  } catch { return null }
}

export function ContextFilters({ repositoryId, facets, metadata, periods, chooseValue, choosePeriod, remove, tagTokens = {} }: {
  tagTokens?: Record<string, number>
  repositoryId: string
  facets: ContinuumFacet[]
  metadata: Record<string, ContinuumScalar>
  periods: Record<string, ContinuumPeriod>
  chooseValue: (key: string, value: ContinuumScalar) => void
  choosePeriod: (key: string, period: ContinuumPeriod) => void
  remove: (key: string) => void
}) {
  const [preference, setPreference] = useState(() => readPreference(repositoryId))
  const [customizing, setCustomizing] = useState(false)
  const [storageError, setStorageError] = useState('')
  const groups = useRef<HTMLDivElement>(null)
  const [allOpen, setAllOpen] = useState(false)
  const selected = preference ?? defaults
  const ordered = [...facets].sort((a, b) => a.key.localeCompare(b.key))
  const customization = preference ?? ordered.filter(facet => defaults.includes(facet.key)).map(facet => facet.key)
  const update = (keys: string[] | null) => {
    setPreference(keys)
    try {
      if (keys === null) localStorage.removeItem(preferenceKey(repositoryId))
      else localStorage.setItem(preferenceKey(repositoryId), JSON.stringify(keys))
      setStorageError('')
    } catch { setStorageError('Não foi possível persistir a personalização neste perfil.') }
  }
  useEffect(() => {
    const root = groups.current
    if (!root) return
    const sync = () => {
      const details = Array.from(root.querySelectorAll('details'))
      setAllOpen(details.length > 0 && details.every(group => group.open))
    }
    root.addEventListener('toggle', sync, true)
    const observer = new MutationObserver(sync)
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] })
    sync()
    return () => { root.removeEventListener('toggle', sync, true); observer.disconnect() }
  }, [])
  const expand = (open: boolean) => { groups.current?.querySelectorAll('details').forEach(group => { group.open = open }); setAllOpen(open) }
  return <>
    <div className="continuum-context-actions">
      <button className="continuum-icon-button" aria-label="Personalizar filtros" title="Personalizar filtros" aria-expanded={customizing} aria-controls="continuum-facet-options" onClick={() => setCustomizing(value => !value)}><SlidersHorizontal size={16} aria-hidden="true" /></button>
      <div><button className="continuum-icon-button" aria-label={allOpen ? 'Recolher tudo' : 'Expandir tudo'} title={allOpen ? 'Recolher tudo' : 'Expandir tudo'} onClick={() => expand(!allOpen)}>{allOpen ? <ChevronsDownUp size={16} aria-hidden="true" /> : <ChevronsUpDown size={16} aria-hidden="true" />}</button></div>
    </div>
    {customizing && <fieldset id="continuum-facet-options" className="continuum-facet-options">
      <legend>Facetas visíveis</legend>
      {ordered.map(facet => <label key={facet.key}><input type="checkbox" checked={selected.includes(facet.key)} onChange={event => update(event.target.checked ? [...customization, facet.key] : customization.filter(key => key !== facet.key))} /><span>{facet.key}</span></label>)}
      <button className="continuum-icon-button" aria-label="Restaurar padrão" title="Restaurar padrão" onClick={() => update(null)}><RotateCcw size={16} aria-hidden="true" /></button>
    </fieldset>}
    {storageError && <p role="alert">{storageError}</p>}
    {(Object.keys(metadata).length > 0 || Object.keys(periods).length > 0) && <section className="continuum-active-filters" aria-label="Filtros ativos">
      <h3>Filtros ativos</h3>
      {Object.entries(metadata).map(([key, value]) => <div key={key}><span>{key}: {String(value)}</span><button className="continuum-icon-button" aria-label={`Remover filtro ${key}`} title={`Remover filtro ${key}`} onClick={() => remove(key)}><X size={14} aria-hidden="true" /></button></div>)}
      {Object.entries(periods).map(([key, period]) => <div key={key}><span>{key}: {period.year}{period.month === undefined ? '' : `-${String(period.month).padStart(2, '0')}`}</span><button className="continuum-icon-button" aria-label={`Remover filtro ${key}`} title={`Remover filtro ${key}`} onClick={() => remove(key)}><X size={14} aria-hidden="true" /></button></div>)}
    </section>}
    <div ref={groups} className="continuum-facet-groups">
      {ordered.filter(facet => selected.includes(facet.key) && (facet.values.length || facet.years?.length)).map(facet => <details key={facet.key}><summary title={facet.key}>{facet.key}</summary>
        <div className="continuum-facet-values">
          {facet.years?.map(year => <div className="continuum-facet-year" key={year.year}>
            <button aria-label={`${facet.key} ${year.year}`} aria-pressed={periods[facet.key]?.year === year.year && periods[facet.key]?.month === undefined} onClick={() => choosePeriod(facet.key, { year: year.year })}><span>{year.year}</span><small>{year.count}</small></button>
            <details><summary aria-label={`months for ${facet.key} ${year.year}`}>months</summary>
              <div className="continuum-facet-months">{year.months.map(month => <button key={month.month} aria-label={`${facet.key} ${year.year}-${String(month.month).padStart(2, '0')}`} aria-pressed={periods[facet.key]?.year === year.year && periods[facet.key]?.month === month.month} onClick={() => choosePeriod(facet.key, { year: year.year, month: month.month })}>
                <span>{new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month.month - 1, 1))).toLowerCase()}</span><small>{month.count}</small>
              </button>)}</div>
            </details>
          </div>)}
          {facet.values.map(entry => <button key={JSON.stringify(entry.value)} aria-pressed={metadata[facet.key] === entry.value} title={`${typeof entry.value}: ${String(entry.value)}`} onClick={() => chooseValue(facet.key, entry.value)}><span>{String(entry.value)}</span><small>{entry.count}{facet.key === 'tags' && tagTokens[String(entry.value)] !== undefined ? ` · ≈ ${tagTokens[String(entry.value)].toLocaleString()} tokens dos documentos` : ''}</small></button>)}
        </div>
      </details>)}
    </div>
  </>
}
