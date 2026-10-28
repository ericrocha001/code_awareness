import React from 'react'
import { ChevronDown, CircleAlert, CircleCheck } from 'lucide-react'
import type { BundleCompressionReport } from '../../../../shared/types/continuum-builder-types'

export function BundleCompressionStatus({ report }: { report: BundleCompressionReport }) {
  const warning = !report.applied && report.profile !== 'off'
  return <div className="continuum-builder-compression-result" data-state={report.applied ? 'applied' : warning ? 'unchanged' : 'disabled'} role="status">
    <strong className="continuum-builder-result-title">{report.applied ? <CircleCheck size={21} /> : <CircleAlert size={21} />}{report.applied ? 'Compressão aplicada' : warning ? 'Sem redução neste pacote' : 'Compressão desativada'}</strong>
    <div className="continuum-builder-metrics">
      <div><b>{report.originalTokens.toLocaleString()}</b><small>tokens originais</small></div>
      <div><b>{report.outputTokens.toLocaleString()}</b><small>tokens na saída</small></div>
      <div><b>{report.savedPercent.toFixed(1)}%</b><small>redução</small></div>
    </div>
    <details><summary>Diagnóstico da compressão <ChevronDown size={19} /></summary>
      <p>{report.reason}</p>
      <p>Perfil: {report.profile} · {report.applied ? 'aplicada' : 'não aplicada'} · economia líquida: {report.savedTokens.toLocaleString()} tokens.</p>
      {report.detectedBlocks === undefined ? <p>Este resultado histórico não contém contagem de blocos detectados.</p> : <p>{report.detectedBlocks} blocos detectados · {report.transformedBlocks} transformados · {report.unchangedBlocks ?? 0} sem transformação · {report.rejectedBlocks ?? 0} rejeitados por fidelidade.</p>}
      <p>PAKT L1–L3 comprime estruturas reconhecidas, sem reescrever prosa. A saída só é usada com reconstrução byte a byte e economia positiva, incluindo notação e proveniência.</p>
    </details>
  </div>
}
