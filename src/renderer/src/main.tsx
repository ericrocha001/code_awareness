// Responsabilidades do Script
//
// 1. Inicializar a aplicação React montando o componente raiz App na árvore DOM.
// 2. Importar e carregar os estilos CSS globais do processo de renderização.

import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
