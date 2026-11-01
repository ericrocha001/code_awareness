import { Button } from '../../../src/renderer/src/components/shared/Button/Button'
import { ContextHelp } from '../../../src/renderer/src/components/shared/ContextHelp/ContextHelp'
import { SelectField } from '../../../src/renderer/src/components/shared/SelectField/SelectField'

export const Fixture = () => <>
  <Button variant="solid" iconOnly icon={<svg aria-hidden="true" />} />
  <Button size="tiny">Salvar</Button>
  <ContextHelp label=" "><p>Ajuda</p></ContextHelp>
  <SelectField label=""><option>Local</option></SelectField>
  <select><option>Local</option></select>
  <div data-ui-state="error" style={{ color: 'var(--brand-violet)' }}>Falhou</div>
</>
