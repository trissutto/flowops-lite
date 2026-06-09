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
 * Tabela oficial Lurd's. Cada faixa é INCLUSIVA nos 2 lados (>= min, <= max).
 * Se cliente está acima do 60 ou abaixo do 46, retorna o limite.
 *
 * Valores baseados em padrão plus size BR genérico — ajustar com base no
 * modelista de você se as conversões reais forem diferentes.
 */
const TABELA = [
  { tamanho: 46, busto: [100, 104], cintura: [84, 88],   quadril: [108, 112] },
  { tamanho: 48, busto: [104, 108], cintura: [88, 92],   quadril: [112, 116] },
  { tamanho: 50, busto: [108, 112], cintura: [92, 96],   quadril: [116, 120] },
  { tamanho: 52, busto: [112, 116], cintura: [96, 100],  quadril: [120, 124] },
  { tamanho: 54, busto: [116, 120], cintura: [100, 104], quadril: [124, 128] },
  { tamanho: 56, busto: [120, 124], cintura: [104, 108], quadril: [128, 132] },
  { tamanho: 58, busto: [124, 128], cintura: [108, 112], quadril: [132, 136] },
  { tamanho: 60, busto: [128, 132], cintura: [112, 116], quadril: [136, 140] },
] as const;

/** Tamanhos disponíveis no catálogo (espelha catalog/sizes do backend). */
const TAMANHOS_DISPONIVEIS = [46, 48, 50, 52, 54, 56, 58, 60];

/**
 * Mapeia uma medida em cm pro tamanho correspondente.
 * Se ultrapassar 60, retorna 60 (peça maior que catalogamos).
 * Se for menor que 46, retorna 46.
 */
function tamanhoPorMedida(
  valor: number,
  campo: 'busto' | 'cintura' | 'quadril',
): number {
  for (const linha of TABELA) {
    const [min, max] = linha[campo];
    if (valor >= min && valor <= max) return linha.tamanho;
  }
  // Acima do 60
  if (valor > TABELA[TABELA.length - 1][campo][1]) return 60;
  // Abaixo do 46
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
