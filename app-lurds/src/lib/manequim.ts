/**
 * Calculadora de Manequim Lurd's Plus Size.
 *
 * Cliente informa busto, cintura e quadril (cm) → algoritmo cruza com
 * tabela de tamanhos Lurd's (46-60) e devolve:
 *   - Tamanho geral (mais conservador: maior dos 3)
 *   - Tamanho por categoria (blusas/calças/vestidos diferem!)
 *   - Confiança (alta/media/baixa baseada no spread)
 *
 * Diferencial real plus size: a maioria dos sistemas dá UM tamanho. A gente
 * dá por categoria porque corpo plus raramente é uniforme — busto pode ser
 * 48 e quadril 52 na mesma pessoa.
 */

export type Manequim = {
  busto: number;
  cintura: number;
  quadril: number;
  tamanhoGeral: number;
  porCategoria: {
    blusas: number;
    calcas: number;
    vestidos: number;
    saias: number;
    macacao: number;
  };
  confianca: 'alta' | 'media' | 'baixa';
  calculadoEm: number;
};

/**
 * Tabela OFICIAL Lurd's Plus Size (extraída do site lurds.com.br nos produtos).
 * Cada faixa é INCLUSIVA no min, EXCLUSIVA no max (>= min, < max) — exceto
 * o tamanho 60 que é o limite superior.
 *
 * Valores do site:
 *   46 → busto 110-115, cintura 95-100, quadril 118-124
 *   48 → busto 115-120, cintura 100-105, quadril 124-130
 *   50 → busto 120-125, cintura 105-110, quadril 130-136
 *   52 → busto 125-130, cintura 110-115, quadril 136-142
 *   54 → busto 130-135, cintura 115-125, quadril 142-148
 *   56 → busto 135-142, cintura 125-135, quadril 148-154
 *   58 → busto 142-150, cintura 135-145, quadril 154-160
 *   60 → busto 150-157, cintura 145-155, quadril 160-166
 *
 * Se mudar a tabela do site, atualizar aqui também.
 */
const TABELA = [
  { tamanho: 46, busto: [110, 115], cintura: [95, 100],  quadril: [118, 124] },
  { tamanho: 48, busto: [115, 120], cintura: [100, 105], quadril: [124, 130] },
  { tamanho: 50, busto: [120, 125], cintura: [105, 110], quadril: [130, 136] },
  { tamanho: 52, busto: [125, 130], cintura: [110, 115], quadril: [136, 142] },
  { tamanho: 54, busto: [130, 135], cintura: [115, 125], quadril: [142, 148] },
  { tamanho: 56, busto: [135, 142], cintura: [125, 135], quadril: [148, 154] },
  { tamanho: 58, busto: [142, 150], cintura: [135, 145], quadril: [154, 160] },
  { tamanho: 60, busto: [150, 157], cintura: [145, 155], quadril: [160, 166] },
] as const;

/** Tamanhos disponíveis no catálogo (espelha catalog/sizes do backend). */
const TAMANHOS_DISPONIVEIS = [46, 48, 50, 52, 54, 56, 58, 60];

/**
 * Mapeia uma medida em cm pro tamanho correspondente.
 *
 * Regra de match: >= min E < max (faixa fechada à esquerda, aberta à direita).
 * Tamanho 60 é a única exceção — fica >= min E <= max (limite superior).
 *
 * Se ultrapassar 157cm (busto), 155cm (cintura) ou 166cm (quadril), retorna
 * 60 (não temos tamanho maior catalogado).
 * Se for menor que 110cm (busto), 95cm (cintura) ou 118cm (quadril), retorna
 * 46 (peças plus size começam aqui).
 */
function tamanhoPorMedida(
  valor: number,
  campo: 'busto' | 'cintura' | 'quadril',
): number {
  for (let i = 0; i < TABELA.length; i++) {
    const linha = TABELA[i];
    const [min, max] = linha[campo];
    const isLast = i === TABELA.length - 1;
    // Última faixa: inclusiva nos 2 lados. Outras: inclusiva só no min.
    if (isLast) {
      if (valor >= min && valor <= max) return linha.tamanho;
    } else {
      if (valor >= min && valor < max) return linha.tamanho;
    }
  }
  // Acima do limite superior do 60 → 60 (maior tamanho)
  if (valor > TABELA[TABELA.length - 1][campo][1]) return 60;
  // Abaixo do limite inferior do 46 → 46 (menor tamanho plus size)
  return 46;
}

/**
 * Calcula o manequim completo. Política plus size:
 *   - Pega o MAIOR dos 3 (peça aperta no maior — sempre dar folga)
 *   - Por categoria, prioriza a medida relevante:
 *     • Blusas/T-shirts → busto
 *     • Calças/saias → max(cintura, quadril)
 *     • Vestidos → max(busto, quadril)
 *     • Macacão → max das 3
 */
export function calcularManequim(
  busto: number,
  cintura: number,
  quadril: number,
): Manequim {
  const tBusto   = tamanhoPorMedida(busto, 'busto');
  const tCintura = tamanhoPorMedida(cintura, 'cintura');
  const tQuadril = tamanhoPorMedida(quadril, 'quadril');

  const tamanhoGeral = Math.max(tBusto, tCintura, tQuadril);

  const porCategoria = {
    blusas:   tBusto,
    calcas:   Math.max(tCintura, tQuadril),
    vestidos: Math.max(tBusto, tQuadril),
    saias:    Math.max(tCintura, tQuadril),
    macacao:  Math.max(tBusto, tCintura, tQuadril),
  };

  // Confiança: spread entre as 3 medidas individuais
  const tamanhos = [tBusto, tCintura, tQuadril];
  const spread = Math.max(...tamanhos) - Math.min(...tamanhos);
  let confianca: 'alta' | 'media' | 'baixa';
  if (spread === 0) confianca = 'alta';
  else if (spread === 2) confianca = 'media';
  else confianca = 'baixa';

  return {
    busto, cintura, quadril,
    tamanhoGeral,
    porCategoria,
    confianca,
    calculadoEm: Date.now(),
  };
}

/* ─────── Persistência localStorage ─────── */

const STORAGE_KEY = 'lurds_manequim';

export function getManequim(): Manequim | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Manequim;
  } catch {
    return null;
  }
}

export function setManequim(m: Manequim | null) {
  if (typeof window === 'undefined') return;
  try {
    if (m) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
      // Sincroniza com lurds_preferred_size (já usado pelo card "Compre por tamanho")
      window.localStorage.setItem('lurds_preferred_size', String(m.tamanhoGeral));
      window.dispatchEvent(new CustomEvent('lurds:size-changed', {
        detail: { size: String(m.tamanhoGeral) },
      }));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent('lurds:manequim-changed', { detail: { manequim: m } }));
  } catch {}
}

/** Mensagem amigável de confiança pra mostrar no resultado. */
export function mensagemConfianca(m: Manequim): string {
  if (m.confianca === 'alta') {
    return `As 3 medidas convergem no mesmo tamanho. Pode comprar tranquila.`;
  }
  if (m.confianca === 'media') {
    return `Suas medidas têm uma pequena variação. Veja o tamanho por categoria.`;
  }
  return `Seu corpo tem proporções únicas — recomendamos seguir tabela por categoria.`;
}
