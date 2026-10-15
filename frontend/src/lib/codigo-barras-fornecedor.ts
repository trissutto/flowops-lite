/**
 * CÓDIGO DE BARRAS DO FORNECEDOR — o que o modal do leitor confere antes de
 * mandar (`npm run test:codigo-barras`).
 *
 * A régua que VALE é a do backend (`backend/src/common/codigo-barras-fornecedor.ts`,
 * que recusa o recebimento inteiro se faltar código). Esta cópia existe pra o
 * modal avançar de linha sozinho a cada bipe e apontar o erro na hora — leitor
 * USB manda o código e um Enter; a pessoa está com a peça na mão e não pode
 * descobrir o problema só depois, na resposta do servidor.
 */

/** Piso do bipe do PDV: na coluna `ean` ele só procura termos com 8+ caracteres. */
export const CODIGO_BARRAS_MIN = 8;
/** Teto da coluna `ean` (VarChar(20)). */
export const CODIGO_BARRAS_MAX = 20;

export type LinhaBipe = {
  /** Identidade da linha na tela: `${grupo}|${tamanho}`. */
  chave: string;
  /** A quem o código pertence quando a tela devolve: id do item (tela do pedido) ou a COR (lançamento). */
  grupo: string;
  ref?: string;
  cor: string;
  tamanho: string;
  qty: number;
  /** Código já lido numa conferência anterior (estornada) — pré-preenche. */
  inicial?: string | null;
};

export function chaveDaLinha(grupo: string, tamanho: string): string {
  return `${grupo}|${tamanho}`;
}

export function normalizarCodigoBarras(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, '').trim().toUpperCase();
}

export function motivoCodigoBarrasInvalido(codigo: string): string | null {
  const c = normalizarCodigoBarras(codigo);
  if (!c) return 'vazio';
  if (c.length < CODIGO_BARRAS_MIN) return `curto demais (mínimo ${CODIGO_BARRAS_MIN} caracteres)`;
  if (c.length > CODIGO_BARRAS_MAX) return `longo demais (máximo ${CODIGO_BARRAS_MAX} caracteres)`;
  if (!/^[A-Z0-9-]+$/.test(c)) return 'só letras, números e hífen';
  return null;
}

/**
 * Próxima linha SEM código, começando depois de `depoisDe` e dando a volta —
 * o leitor pula pra ela sozinho. `null` = todas lidas (o foco vai pro botão).
 */
export function proximaLinhaPendente(
  linhas: LinhaBipe[],
  valores: Record<string, string>,
  depoisDe?: string | null,
): string | null {
  if (!linhas.length) return null;
  const inicio = depoisDe ? linhas.findIndex((l) => l.chave === depoisDe) + 1 : 0;
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[(inicio + i) % linhas.length];
    if (!normalizarCodigoBarras(valores[l.chave])) return l.chave;
  }
  return null;
}

/** Outra linha que já carrega este código — o mesmo EAN em dois tamanhos é erro. */
export function linhaComMesmoCodigo(
  linhas: LinhaBipe[],
  valores: Record<string, string>,
  chave: string,
  codigo: string,
): LinhaBipe | null {
  const c = normalizarCodigoBarras(codigo);
  if (!c) return null;
  return linhas.find((l) => l.chave !== chave && normalizarCodigoBarras(valores[l.chave]) === c) || null;
}

export interface ConferenciaLeitura {
  ok: boolean;
  lidas: number;
  faltando: LinhaBipe[];
  invalidas: Array<{ linha: LinhaBipe; motivo: string }>;
  repetidas: Array<{ codigo: string; linhas: LinhaBipe[] }>;
}

/** O que ainda impede o "Confirmar": falta, inválido ou repetido. */
export function conferirLeitura(linhas: LinhaBipe[], valores: Record<string, string>): ConferenciaLeitura {
  const faltando: LinhaBipe[] = [];
  const invalidas: ConferenciaLeitura['invalidas'] = [];
  const porCodigo = new Map<string, LinhaBipe[]>();
  let lidas = 0;
  for (const linha of linhas) {
    const codigo = normalizarCodigoBarras(valores[linha.chave]);
    if (!codigo) { faltando.push(linha); continue; }
    const motivo = motivoCodigoBarrasInvalido(codigo);
    if (motivo) { invalidas.push({ linha, motivo }); continue; }
    lidas++;
    porCodigo.set(codigo, [...(porCodigo.get(codigo) || []), linha]);
  }
  const repetidas = Array.from(porCodigo.entries())
    .filter(([, ls]) => ls.length > 1)
    .map(([codigo, ls]) => ({ codigo, linhas: ls }));
  return {
    ok: faltando.length === 0 && invalidas.length === 0 && repetidas.length === 0,
    lidas,
    faltando,
    invalidas,
    repetidas,
  };
}

/** O que vai no `/receive`: grupo (item ou cor) → tamanho → código normalizado. */
export function montarEansPorGrupo(
  linhas: LinhaBipe[],
  valores: Record<string, string>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const linha of linhas) {
    const codigo = normalizarCodigoBarras(valores[linha.chave]);
    if (!codigo) continue;
    (out[linha.grupo] ||= {})[linha.tamanho] = codigo;
  }
  return out;
}
