import { Button as Action } from '../../../src/renderer/src/components/shared/Button/Button'
import { ContextHelp } from '../../../src/renderer/src/components/shared/ContextHelp/ContextHelp'
import { SelectField } from '../../../src/renderer/src/components/shared/SelectField/SelectField'

export const Fixture = () => <>
  <Action variant="solid" intent="primary" size="comfortable">Salvar</Action>
  <Action variant="outline" iconOnly aria-label="Adicionar" icon={<svg aria-hidden="true" />} />
  <ContextHelp label="Sobre o destino"><p>Detalhes sob demanda.</p></ContextHelp>
  <SelectField label="Destino"><option>Local</option></SelectField>
  <label htmlFor="native-destination">Destino nativo</label><select id="native-destination"><option>Local</option></select>
  <div data-ui-state="error" style={{ color: 'var(--ui-danger)' }}>Falhou</div>
</>
