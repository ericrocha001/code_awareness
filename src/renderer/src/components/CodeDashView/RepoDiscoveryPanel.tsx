import React, { useState } from 'react'
import { Check, Copy, Download, Loader2, Map, Play } from 'lucide-react'
import { REPO_DISCOVERY_PROTOCOL_VERSION, type RepoDiscoveryLayer, type RepoDiscoveryResult } from '../../../../shared/types/repo-discovery-types'

interface RepoDiscoveryPanelProps {
  repoPath: string
  projectName: string
}

type DiscoveryState = 'idle' | 'generating' | 'done' | 'error'

const LAYERS: Array<{ value: RepoDiscoveryLayer; label: string }> = [
  { value: 1, label: 'Inventory' },
  { value: 2, label: 'Connections' }
]

export const RepoDiscoveryPanel: React.FC<RepoDiscoveryPanelProps> = ({ repoPath, projectName }) => {
  const [layer, setLayer] = useState<RepoDiscoveryLayer>(1)
  const [state, setState] = useState<DiscoveryState>('idle')
  const [result, setResult] = useState<RepoDiscoveryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const generate = async () => {
    setState('generating')
    setResult(null)
    setError(null)
    const response = await window.codeAwareness.dashDiscover({
      protocol: REPO_DISCOVERY_PROTOCOL_VERSION,
      operation: 'discovery',
      layer
    }, repoPath)
    if (response.success && response.data) {
      setResult(response.data)
      setState('done')
    } else {
      setError(response.error ?? 'Repo Discovery failed.')
      setState('error')
    }
  }

  const copy = async () => {
    if (!result) return
    await navigator.clipboard.writeText(result.content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const exportMap = async () => {
    if (!result) return
    const response = await window.codeAwareness.saveMarkdown(result.content, `${projectName}-repo-map-l${result.layer}`)
    if (!response.success) setError(response.error ?? 'Unable to export Repo Map.')
  }

  return (
    <section className="repo-discovery" aria-labelledby="repo-discovery-title">
      <div className="repo-discovery-heading">
        <div>
          <h3 id="repo-discovery-title"><Map size={17} /> Repo Discovery</h3>
          <p>Explore os arquivos e suas conexoes antes de solicitar contexto detalhado.</p>
        </div>
        <div className="repo-discovery-layers" aria-label="Repo Map layer">
          {LAYERS.map((option) => (
            <button
              type="button"
              key={option.value}
              className={layer === option.value ? 'active' : ''}
              aria-pressed={layer === option.value}
              onClick={() => setLayer(option.value)}
              disabled={state === 'generating'}
            >
              <span>L{option.value}</span>
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="repo-discovery-actions">
        <button type="button" className="app-ghost-btn repo-discovery-generate" onClick={generate} disabled={state === 'generating'}>
          {state === 'generating' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          <span>{state === 'generating' ? 'Generating Repo Map...' : 'Generate Repo Map'}</span>
        </button>
        {result && (
          <>
            <button type="button" className="app-ghost-btn" onClick={copy} title="Copy Repo Map">
              {copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
            <button type="button" className="app-ghost-btn" onClick={exportMap} title="Export Repo Map">
              <Download size={14} /><span>Export</span>
            </button>
          </>
        )}
      </div>

      {error && <div className="repo-discovery-error" role="alert">{error}</div>}
      {result && (
        <div className="repo-discovery-result">
          <div className="repo-discovery-meta">
            <span>Layer {result.layer}</span>
            <span>{(result.mapTokenCount ?? result.tokenCount).toLocaleString('pt-BR')} Repo Map tokens</span>
            <span>{result.fileCount} files</span>
            <span>{result.generationMs.toLocaleString('pt-BR')} ms</span>
          </div>
          <pre><code>{result.content}</code></pre>
        </div>
      )}
    </section>
  )
}
