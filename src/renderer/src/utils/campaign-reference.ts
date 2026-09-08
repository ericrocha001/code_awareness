/*
-T ---
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