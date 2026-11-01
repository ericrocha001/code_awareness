import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../../../src/renderer/src/components/shared/Button/Button'
import { ContextHelp } from '../../../src/renderer/src/components/shared/ContextHelp/ContextHelp'
import { SelectField } from '../../../src/renderer/src/components/shared/SelectField/SelectField'
import '../../../src/renderer/src/index.css'
import './ui-primitives-fixture.css'

function Fixture() {
  const [destination, setDestination] = useState('local')
  const [selected, setSelected] = useState(false)
  return <main className="primitive-fixture">
    <header><div className="primitive-fixture-icon" aria-hidden="true"><Plus size={28} /></div>
      <div><h1>Primitivas de interface</h1><p>Fixture sintética · componentes reais · sem dados pessoais</p></div></header>
    <section aria-label="Ações compartilhadas">
      <h2>Ações claras, estados reconhecíveis</h2>
      <div className="primitive-actions">
        <Button variant="solid" intent="primary">Criar arquivo</Button>
        <Button variant="outline" selected={selected} onClick={() => setSelected(!selected)}>Selecionar</Button>
        <Button variant="outline" intent="danger" icon={<Trash2 size={18} />}>Excluir arquivo</Button>
        <Button variant="subtle" disabled>Indisponível</Button>
        <Button variant="outline" iconOnly aria-label="Adicionar arquivo" icon={<Plus size={18} />} />
      </div>
    </section>
    <section aria-label="Escolha e ajuda">
      <div className="primitive-field-heading"><h2>Onde salvar</h2>
        <ContextHelp label="Ajuda sobre o destino" hint="Compare os destinos disponíveis.">
          <p>O destino local permanece nesta execução. O temporário será removido ao encerrar.</p>
          <label>Buscar na ajuda <input aria-label="Buscar na ajuda" /></label>
          <p><a href="#destino">Ver escolha de destino</a></p>
        </ContextHelp></div>
      <SelectField id="destino" label="Destino do arquivo" description="Escolha o destino para esta execução sintética."
        value={destination} onChange={event => setDestination(event.target.value)}>
        <option value="local">Local — manter nesta execução</option>
        <option value="temporary">Temporário — remover ao encerrar</option>
      </SelectField>
      <p className="primitive-warning" role="note">Atenção: excluir remove o arquivo. Confirme o destino antes de continuar.</p>
      <output aria-label="Destino selecionado">{destination === 'local' ? 'Local selecionado' : 'Temporário selecionado'}</output>
    </section>
    <section aria-label="Compatibilidade"><h2>Contrato existente</h2><Button>Botão legado</Button><Button variant="ghost">Ação legada</Button></section>
  </main>
}
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<Fixture />)
