/*
-T ---
*/

/**
 * Script de benchmark para execução no DevTools Console do Electron.
 * 
 * Instruções de uso:
 * 1. Abra a aplicação com um projeto contendo grande volume de arquivos (ex: 500, 1000, 1500 arquivos).
 * 2. Abra o DevTools (Ctrl+Shift+I).
 * 3. Cole o snippet abaixo no Console e execute.
 */

function benchmarkFileCollection() {
  const results = {
    timestamp: new Date().toISOString(),
    viewType: 'unknown',
    activeDomCards: 0,
    activeDomRows: 0,
    totalDomElements: 0,
    toggleResponseTimeMs: 'N/A',
    memoryEstimate: null
  }

  // 1. Contagem de nós DOM
  results.activeDomCards = document.querySelectorAll('.file-card').length
  results.activeDomRows = document.querySelectorAll('.fr-row').length
  results.totalDomElements = results.activeDomCards + results.activeDomRows

  if (results.activeDomCards > 0 && results.activeDomRows === 0) {
    results.viewType = 'Grid (FileGrid legado ou FileGridView)'
  } else if (results.activeDomRows > 0) {
    results.viewType = 'File (FileView)'
  }

  // 2. Medição de tempo de resposta a clique de seleção (toggle)
  const firstToggle = document.querySelector('[role="switch"]')
  if (firstToggle) {
    const start = performance.now()
    firstToggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    requestAnimationFrame(() => {
      const end = performance.now()
      results.toggleResponseTimeMs = (end - start).toFixed(2)
      console.log(`[Benchmark] Resposta de Toggle: ${results.toggleResponseTimeMs} ms`)
    })
  }

  // 3. Estimativa de memória JS Heap se disponível
  if (performance.memory) {
    results.memoryEstimate = {
      usedJSHeapSizeMB: (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2),
      totalJSHeapSizeMB: (performance.memory.totalJSHeapSize / (1024 * 1024)).toFixed(2)
    }
  }

  console.table(results)
  return results
}

/**
 * Utilitário para medir FPS de scroll contínuo durante 5 segundos
 */
function benchmarkScrollFps(scrollContainerSelector = '.fgv-scroll-container, .fv-scroll-container, .file-grid') {
  const container = document.querySelector(scrollContainerSelector)
  if (!container) {
    console.error(`[Benchmark] Container de scroll não encontrado com seletor: ${scrollContainerSelector}`)
    return
  }

  console.log('[Benchmark] Iniciando teste de FPS de rolagem por 5 segundos...')
  let frames = 0
  let startTime = performance.now()
  let isScrolling = true

  function countFrame() {
    if (!isScrolling) return
    frames++
    requestAnimationFrame(countFrame)
  }

  requestAnimationFrame(countFrame)

  // Scroll programático contínuo
  const scrollInterval = setInterval(() => {
    container.scrollTop += 50
    if (container.scrollTop + container.clientHeight >= container.scrollHeight) {
      container.scrollTop = 0
    }
  }, 16)

  setTimeout(() => {
    isScrolling = false
    clearInterval(scrollInterval)
    const duration = (performance.now() - startTime) / 1000
    const fps = (frames / duration).toFixed(1)
    console.log(`[Benchmark] Teste concluído: ${frames} frames em ${duration.toFixed(2)}s -> Média: ${fps} FPS`)
  }, 5000)
}

if (typeof module !== 'undefined') {
  module.exports = { benchmarkFileCollection, benchmarkScrollFps }
}
