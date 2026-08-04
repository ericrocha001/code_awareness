/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir o tipo CampaignReference e as constantes internas de protocolo, host e versão.
2. Construir o endereço de uma campanha a partir de repoPath e campaignId.
3. Interpretar um endereço de campanha, devolvendo a referência ou null.
4. Montar o cartão Markdown clicável a partir do nome, repoPath e campaignId.

Mapa de Relacionamentos do Script

1. CodeCampaignView.tsx / CampaignList.tsx
   - Tipo: Dependência Inversa
   - Relação: Consumidor planejado na Sprint 2 — "A Boca".
   - Criticidade: Alta

2. deep-link-resolver.ts / App.tsx
   - Tipo: Dependência Inversa
   - Relação: Consumidor planejado na Sprint 4 — "O Cérebro".
   - Criticidade: Alta

3. (Nenhuma dependência direta — o módulo é uma folha pura; não importa de shared/types nem de electron.)

Invariantes do Script

1. Todas as funções são puras — sem side effects, sem IPC, sem acesso a DOM/Electron/localStorage/banco.
2. O formato do endereço é path-based: codeawareness://campanha/<versão>/<repoPath encodado>/<campaignId encodado>; o host é sempre campanha e o protocolo sempre codeawareness:.
3. parseCampaignReference nunca lança — qualquer entrada inválida retorna null.
4. Apenas a versão 1 é aceita no parse; versão ausente ou diferente retorna null (forward-safety).
5. A construção usa encodeURIComponent nos segmentos do path. O parse faz leitura direta da string (sem new URL(), que não reconhece o protocolo customizado) e usa decodeURIComponent nos segmentos.
6. repoPath e campaignId são retornados pelo parse sem trim (preservando fidelidade do caminho); a rejeição de "vazio" é feita verificando se, após trim, o comprimento é zero.
7. O label do cartão Markdown escapa \, [ e ] e substitui quebras de linha por espaço, para não quebrar a sintaxe do link.
8. O campaignId é a âncora de estabilidade da referência (não o slug); o nome entra apenas no label visível.
9. O parseCampaignReference faz leitura direta da string, sem usar new URL() — o protocolo customizado codeawareness:// não é reconhecido pela API URL, que devolve hostname vazio.

--- FIM ARQUITETURA DO SCRIPT ---
*/

// Constantes internas — detalhes de implementação, não exportar.
// URL.protocol inclui os dois pontos, por isso o scheme termina em ':'.
const CAMPAIGN_REFERENCE_SCHEME = 'codeawareness:';
const CAMPAIGN_REFERENCE_HOST = 'campanha';
const REFERENCE_VERSION = 1;

export interface CampaignReference {
  version: number;
  repoPath: string;
  campaignId: string;
}

// Escapa caracteres que quebram a sintaxe [texto](url) do Markdown.
// A ordem importa: escapar '\' primeiro evita que escapes gerados virem alvo de novo escape.
function escapeMarkdownLinkLabel(label: string): string {
  return label
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/[\r\n]+/g, ' ');
}

// Construção path-based: sem '?' e sem '&', evitando que o Windows trunque a URL
// (o shell interpreta '&' como separador de comandos). encodeURIComponent codifica
// barras do repoPath (%5C para '\', %2F para '/'), impedindo que conflitem com o
// separador '/' do path da URL.
export function buildCampaignReference(repoPath: string, campaignId: string): string {
  const segments = [
    String(REFERENCE_VERSION),
    encodeURIComponent(repoPath),
    encodeURIComponent(campaignId)
  ];
  return `${CAMPAIGN_REFERENCE_SCHEME}//${CAMPAIGN_REFERENCE_HOST}/${segments.join('/')}`;
}

// Fronteira de confiança com o mundo externo: nunca lança.
// Leitura direta da string — new URL() não reconhece o protocolo customizado
// codeawareness:// e devolve hostname vazio. O parse manual contorna isso.
export function parseCampaignReference(url: string): CampaignReference | null {
  console.log('[DL][parse-in]', JSON.stringify(url));
  if (typeof url !== 'string' || url.length === 0) {
    console.log('[DL][parse-out] empty');
    return null;
  }

  // Prefixo fixo: a "assinatura" do nosso formato path-based.
  // Substitui as antigas checagens de protocolo e hostname via new URL().
  const prefix = `${CAMPAIGN_REFERENCE_SCHEME}//${CAMPAIGN_REFERENCE_HOST}/`;
  if (!url.startsWith(prefix)) {
    console.log('[DL][parse-out] prefix');
    return null;
  }

  // Restante: <versão>/<repoPath encodado>/<campaignId encodado>
  // encodeURIComponent transforma '/' em %2F, então os segmentos não contêm '/' literal.
  const rest = url.slice(prefix.length);
  const segments = rest.split('/');
  if (segments.length !== 3) {
    console.log('[DL][parse-out] segments', segments.length);
    return null;
  }

  const [versionSeg, repoSeg, idSeg] = segments;
  // Comparação estrita com String(REFERENCE_VERSION): rejeita '01', '1.0', etc.
  if (versionSeg !== String(REFERENCE_VERSION)) {
    console.log('[DL][parse-out] version', versionSeg);
    return null;
  }

  // decodeURIComponent pode lançar URIError em sequências % inválidas — try/catch obrigatório.
  let repoPath: string;
  let campaignId: string;
  try {
    repoPath = decodeURIComponent(repoSeg);
    campaignId = decodeURIComponent(idSeg);
  } catch (e) {
    console.log('[DL][parse-out] decode-threw', String(e));
    return null;
  }

  // Guarda de "vazio" usa trim, mas o valor retornado é o cru (sem trim)
  // para preservar fidelidade do caminho — um path pode ter espaços nas pontas.
  if (repoPath.trim().length === 0) {
    console.log('[DL][parse-out] repo-empty');
    return null;
  }
  if (campaignId.trim().length === 0) {
    console.log('[DL][parse-out] id-empty');
    return null;
  }

  const result = { version: REFERENCE_VERSION, repoPath, campaignId };
  console.log('[DL][parse-out] OK', JSON.stringify(result));
  return result;
}

export function buildCampaignLinkMarkdown(campaignName: string, repoPath: string, campaignId: string): string {
  const label = escapeMarkdownLinkLabel(campaignName);
  const href = buildCampaignReference(repoPath, campaignId);
  return `[🚩 ${label}](${href})`;
}