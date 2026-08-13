import { Injectable } from '@nestjs/common';

/**
 * LURDS FIT AI — motor de recomendação de tamanho (100% proprietário).
 *
 * Função PURA e testável: recebe corpo da cliente + ficha da peça + o que o
 * sistema já aprendeu, devolve tamanho + confiança + a trilha do cálculo.
 * Nada de biblioteca de terceiro, nada copiado — a lógica é da casa e o que
 * a torna precisa é o histórico REAL de venda/troca da Lurd's.
 *
 * Como pensa (nesta ordem):
 *   1. Base pelo corpo: estima busto/cintura/quadril em CM a partir de
 *      peso+altura, corrige pelos portes declarados (busto/quadril P-M-G e
 *      formato) e mapeia na régua de medidas da grade — o eixo que decide
 *      depende da categoria (busto em cima, quadril embaixo, vestido fecha
 *      no maior)
 *   2. Âncora no tamanho que a cliente JÁ USA (sinal mais forte que existe)
 *   3. Ajuste da PEÇA (modelagem, elastano, caimento)
 *   4. Preferência de caimento da cliente (justa/normal/soltinha)
 *   5. VIÉS APRENDIDO — o que as trocas reais dessa peça ensinaram
 *
 * Trabalha em ÍNDICE da grade (0=46 … 7=60), não no número: assim "meio
 * tamanho" tem significado e o arredondamento acontece só no fim.
 *
 * ── CALIBRAÇÃO (13/08/2026) ──────────────────────────────────────────────
 * A base anterior era uma tabela IMC→tamanho que recomendava 2 A 3 NÚMEROS
 * ACIMA do que o mercado plus veste (1,62m/90kg caía no 54; as tabelas de
 * loja plus dizem 46-48) e a correção de altura tinha o sinal invertido
 * (em IMC igual, a mulher mais alta tem perímetros MAIORES, não menores —
 * circunferência ∝ √(peso/altura), e o IMC já divide por altura²).
 *
 * Fontes da recalibração:
 *  - Régua tamanho→medidas: consolidação de tabelas plus brasileiras
 *    (numeração 46-60, passo de 4-5 cm por número nos três perímetros).
 *  - Corpo→medidas: perímetro = a·√(peso/altura) + b, ajustada em três
 *    âncoras de estudos antropométricos femininos — população média do
 *    SizeUK (~68 kg: busto 99, quadril 104), média adulta dos EUA/NHANES
 *    (~77 kg: cintura 99, quadril 110) e coorte SOON de obesidade severa
 *    (117 kg / IMC 44: cintura 123, quadril 134).
 * O tamanho habitual declarado e o viés aprendido das trocas continuam
 * sendo quem afina a pontaria peça a peça.
 */

export const GRADE_PLUS = ['46', '48', '50', '52', '54', '56', '58', '60'];

/**
 * Régua da casa: medidas de CORPO (cm) que cada número da grade veste.
 * Consolidada das tabelas do varejo plus nacional — enquanto não houver
 * grade própria cadastrada (grades_medidas), esta é a referência única,
 * também pro guia e pra ficha de caimento.
 */
export const MEDIDAS_POR_TAMANHO: Record<string, { busto: number; cintura: number; quadril: number }> = {
  '46': { busto: 108, cintura: 92, quadril: 116 },
  '48': { busto: 113, cintura: 97, quadril: 121 },
  '50': { busto: 118, cintura: 102, quadril: 126 },
  '52': { busto: 122, cintura: 107, quadril: 131 },
  '54': { busto: 126, cintura: 112, quadril: 135 },
  '56': { busto: 130, cintura: 117, quadril: 139 },
  '58': { busto: 134, cintura: 122, quadril: 143 },
  '60': { busto: 138, cintura: 127, quadril: 147 },
};

export type Preferencia = 'justa' | 'normal' | 'soltinha';
export type Porte = 'P' | 'M' | 'G';
export type FormatoCorpo = 'ampulheta' | 'pera' | 'maca' | 'retangulo' | 'naosei';

export interface FitCorpo {
  alturaCm: number;
  pesoKg: number;
  idade?: number | null;
  preferencia: Preferencia;
  formatoCorpo?: FormatoCorpo | null;
  busto?: Porte | null;
  quadril?: Porte | null;
  tamanhoHabitual?: string | null;
}

export interface FitPeca {
  ref?: string | null;
  categoria?: string | null;          // vestido|blusa|calca|legging|jaqueta|camisa|saia|macacao
  marca?: string | null;
  modelagem?: 'pequena' | 'normal' | 'grande' | null;
  elastano?: 'sem' | 'pouco' | 'muito' | null;
  caimento?: 'justo' | 'normal' | 'amplo' | null;
  composicao?: string | null;
  /** Tamanhos que existem em estoque — a recomendação nunca sai fora deles. */
  tamanhosDisponiveis?: string[] | null;
}

export interface FitAprendizado {
  /** Viés médio em PASSOS de grade (+1 = peça veste pequeno, suba um número) */
  viesRef?: number | null;
  amostrasRef?: number;
  viesCategoria?: number | null;
  amostrasCategoria?: number;
  viesMarca?: number | null;
  amostrasMarca?: number;
  /** Taxa de troca da peça (0–1) — peça problemática derruba a confiança */
  taxaTroca?: number | null;
}

export interface FitResultado {
  tamanho: string;
  tamanhoAlt: string | null;
  confianca: number;              // 0–100
  estrelas: number;               // 1–5
  falarComConsultora: boolean;
  titulo: string;
  frases: string[];
  trilha: Array<{ etapa: string; ajuste: number; indice: number; nota: string }>;
}

/** Peças em que o BUSTO manda / em que o QUADRIL manda; o resto é inteira. */
const CATEGORIA_CIMA = /blusa|camisa|jaqueta|casaco|body|cropped|regata|blazer|top/i;
const CATEGORIA_BAIXO = /calca|calça|legging|saia|short|pantalona/i;

interface Medidas { busto: number; cintura: number; quadril: number }

@Injectable()
export class FitEngineService {
  /**
   * Corpo → medidas estimadas (cm). Modelo alométrico: o tronco é um volume,
   * então perímetro cresce com √(peso/altura) — a altura entra na física,
   * não como remendo. Coeficientes ajustados nas âncoras femininas do
   * cabeçalho (SizeUK / NHANES / SOON).
   */
  private estimarMedidas(corpo: FitCorpo): { neutras: Medidas; ajustadas: Medidas; notas: string[] } {
    const alturaM = Math.max(1.3, Math.min(2.1, corpo.alturaCm / 100));
    const s = Math.sqrt(Math.max(35, Math.min(250, corpo.pesoKg)) / alturaM);

    const neutras: Medidas = {
      busto: 13.5 * s + 11.5,
      cintura: 15.5 * s - 11,
      quadril: 15.5 * s + 2.5,
    };

    // O porte declarado corrige a estimativa média: ±5 cm ≈ ±1 número no eixo.
    const aj: Medidas = { ...neutras };
    const notas: string[] = [];
    if (corpo.busto === 'G') { aj.busto += 5; notas.push('busto grande'); }
    if (corpo.busto === 'P') { aj.busto -= 5; notas.push('busto pequeno'); }
    if (corpo.quadril === 'G') { aj.quadril += 5; notas.push('quadril grande'); }
    if (corpo.quadril === 'P') { aj.quadril -= 5; notas.push('quadril pequeno'); }
    switch (corpo.formatoCorpo) {
      case 'pera':      aj.quadril += 3; aj.busto -= 2; notas.push('corpo pera'); break;
      case 'maca':      aj.busto += 3; aj.cintura += 5; aj.quadril -= 2; notas.push('corpo maçã'); break;
      case 'ampulheta': aj.cintura -= 4; notas.push('corpo ampulheta'); break;
      case 'retangulo': aj.cintura += 3; aj.quadril -= 2; notas.push('corpo retângulo'); break;
    }
    return { neutras, ajustadas: aj, notas };
  }

  /** Medida (cm) → índice fracionário na régua da grade, com extrapolação nas pontas. */
  private idxPorMedida(eixo: keyof Medidas, cm: number): number {
    const vals = GRADE_PLUS.map((t) => MEDIDAS_POR_TAMANHO[t][eixo]);
    const n = vals.length;
    if (cm <= vals[0]) return (cm - vals[0]) / (vals[1] - vals[0]);
    if (cm >= vals[n - 1]) return n - 1 + (cm - vals[n - 1]) / (vals[n - 1] - vals[n - 2]);
    for (let i = 0; i < n - 1; i++) {
      if (cm <= vals[i + 1]) return i + (cm - vals[i]) / (vals[i + 1] - vals[i]);
    }
    return n - 1;
  }

  /**
   * Índice-base pela categoria: blusa fecha no busto, calça no quadril
   * (cintura pesa pouco — no plus ela costuma ser elástica), vestido tem
   * que fechar no MAIOR eixo. Eixos limitados pra uma estimativa extrema
   * de cintura não arrastar o resultado sozinha.
   */
  private mixPorCategoria(categoria: string | null | undefined, m: Medidas): { indice: number; eixos: Record<string, number> } {
    const lim = (v: number) => Math.max(-1.5, Math.min(9, v));
    const B = lim(this.idxPorMedida('busto', m.busto));
    const C = lim(this.idxPorMedida('cintura', m.cintura));
    const Q = lim(this.idxPorMedida('quadril', m.quadril));

    const cat = String(categoria || '');
    const ehCima = CATEGORIA_CIMA.test(cat);
    const ehBaixo = CATEGORIA_BAIXO.test(cat);

    let indice: number;
    if (ehCima) indice = 0.85 * B + 0.15 * C;
    else if (ehBaixo) indice = 0.7 * Q + 0.3 * C;
    else indice = 0.6 * Math.max(B, Q) + 0.3 * Math.min(B, Q) + 0.1 * C; // inteira/desconhecida

    return { indice, eixos: { B, C, Q } };
  }

  private indiceDe(tamanho?: string | null): number | null {
    if (!tamanho) return null;
    const t = String(tamanho).trim().toUpperCase();
    const i = GRADE_PLUS.indexOf(t);
    return i >= 0 ? i : null;
  }

  private clamp(i: number): number {
    return Math.max(0, Math.min(GRADE_PLUS.length - 1, i));
  }

  /** Shrinkage bayesiano: viés só vale proporcional ao tamanho da amostra. */
  private viesConfiavel(vies?: number | null, amostras = 0, k = 5): number {
    if (!vies || !amostras) return 0;
    return vies * (amostras / (amostras + k));
  }

  recomendar(corpo: FitCorpo, peca: FitPeca, aprend: FitAprendizado = {}): FitResultado {
    const trilha: FitResultado['trilha'] = [];
    const push = (etapa: string, ajuste: number, indice: number, nota: string) =>
      trilha.push({ etapa, ajuste: Number(ajuste.toFixed(2)), indice: Number(indice.toFixed(2)), nota });

    // ── 1) BASE PELO CORPO ────────────────────────────────────────────────
    const alturaM = Math.max(1.3, Math.min(2.1, corpo.alturaCm / 100));
    const imc = corpo.pesoKg / (alturaM * alturaM);
    const { neutras, ajustadas, notas } = this.estimarMedidas(corpo);

    const neutro = this.mixPorCategoria(peca.categoria, neutras);
    const base = this.mixPorCategoria(peca.categoria, ajustadas);
    const baseBruta = base.indice; // antes do clamp — guarda o "quão fora da grade"
    let idx = this.clamp(base.indice);

    push('corpo', 0, this.clamp(neutro.indice),
      `${corpo.alturaCm}cm/${corpo.pesoKg}kg (IMC ${imc.toFixed(1)}) → busto ~${Math.round(neutras.busto)}, ` +
      `cintura ~${Math.round(neutras.cintura)}, quadril ~${Math.round(neutras.quadril)}cm → ${GRADE_PLUS[Math.round(this.clamp(neutro.indice))]}`);
    if (notas.length) {
      push('proporcao', base.indice - neutro.indice, idx, notas.join(' + '));
    }

    // ── 2) ÂNCORA NO TAMANHO QUE ELA JÁ USA ───────────────────────────────
    // É o sinal mais forte do formulário: a cliente já viveu o corpo dela em
    // roupa. A estimativa entra como contrapeso (ela pode estar comprando errado).
    const idxHabitual = this.indiceDe(corpo.tamanhoHabitual);
    const temHabitual = idxHabitual !== null;
    let discordancia = 0;
    if (temHabitual) {
      discordancia = Math.abs(idxHabitual! - idx);
      const antes = idx;
      idx = 0.45 * idx + 0.55 * idxHabitual!;
      push('habitual', idx - antes, idx, `costuma vestir ${corpo.tamanhoHabitual} (peso 55%)`);
    }

    // ── 3) A PEÇA ─────────────────────────────────────────────────────────
    const semFichaPeca = !peca.modelagem && !peca.elastano && !peca.caimento;
    if (peca.modelagem === 'pequena') { idx += 1; push('modelagem', +1, idx, 'modelagem pequena — veste menor'); }
    if (peca.modelagem === 'grande')  { idx -= 1; push('modelagem', -1, idx, 'modelagem grande — veste maior'); }

    if (peca.elastano === 'muito') { idx -= 0.5; push('elastano', -0.5, idx, 'muito elastano — o tecido cede'); }
    if (peca.elastano === 'sem')   { idx += 0.5; push('elastano', +0.5, idx, 'sem elastano — o tecido não cede'); }

    if (peca.caimento === 'justo') { idx += 0.5; push('caimento', +0.5, idx, 'caimento justo'); }
    if (peca.caimento === 'amplo') { idx -= 0.5; push('caimento', -0.5, idx, 'caimento amplo'); }

    // ── 4) COMO ELA GOSTA ─────────────────────────────────────────────────
    if (corpo.preferencia === 'justa')    { idx -= 0.5; push('preferencia', -0.5, idx, 'prefere mais justa'); }
    if (corpo.preferencia === 'soltinha') { idx += 0.5; push('preferencia', +0.5, idx, 'prefere mais soltinha'); }

    // ── 5) O QUE AS TROCAS REAIS ENSINARAM ────────────────────────────────
    const viesRef = this.viesConfiavel(aprend.viesRef, aprend.amostrasRef || 0, 4);
    const viesCat = this.viesConfiavel(aprend.viesCategoria, aprend.amostrasCategoria || 0, 25);
    const viesMarca = this.viesConfiavel(aprend.viesMarca, aprend.amostrasMarca || 0, 25);
    // A REF manda; categoria/marca só entram quando a peça tem pouca amostra.
    const forcaRef = Math.min(1, (aprend.amostrasRef || 0) / 8);
    const viesFinal = viesRef + (1 - forcaRef) * (viesCat * 0.6 + viesMarca * 0.4);
    if (Math.abs(viesFinal) >= 0.05) {
      idx += viesFinal;
      push('aprendizado', viesFinal, idx,
        viesFinal > 0
          ? `clientes trocaram por um número MAIOR (${aprend.amostrasRef || 0} casos)`
          : `clientes trocaram por um número MENOR (${aprend.amostrasRef || 0} casos)`);
    }

    // ── FECHAMENTO ────────────────────────────────────────────────────────
    idx = this.clamp(idx);
    const idxArredondado = Math.round(idx);
    const fracao = Math.abs(idx - idxArredondado); // 0 = cravado, 0.5 = em cima do muro

    let tamanho = GRADE_PLUS[idxArredondado];
    // Alternativa: o vizinho pro lado que a fração aponta (ou o de cima se
    // ela gosta soltinha) — sempre dentro da grade.
    const direcaoAlt = idx > idxArredondado ? 1 : idx < idxArredondado ? -1 : 1;
    let tamanhoAlt: string | null = GRADE_PLUS[this.clamp(idxArredondado + direcaoAlt)] || null;
    if (tamanhoAlt === tamanho) tamanhoAlt = null;

    // Respeita o que existe em estoque
    const disp = (peca.tamanhosDisponiveis || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean);
    let ajustadoPorEstoque = false;
    if (disp.length) {
      if (!disp.includes(tamanho)) {
        const maisProximo = disp
          .map((t) => ({ t, i: this.indiceDe(t) }))
          .filter((x) => x.i !== null)
          .sort((a, b) => Math.abs(a.i! - idx) - Math.abs(b.i! - idx))[0];
        if (maisProximo) { tamanho = maisProximo.t; ajustadoPorEstoque = true; }
      }
      if (tamanhoAlt && !disp.includes(tamanhoAlt)) tamanhoAlt = null;
    }

    // ── CONFIANÇA ─────────────────────────────────────────────────────────
    let conf = 100;
    if (!temHabitual) conf -= 18;
    if (discordancia >= 2) conf -= 14;
    else if (discordancia >= 1.5) conf -= 8;
    if (semFichaPeca) conf -= 15;
    else {
      if (!peca.modelagem) conf -= 5;
      if (!peca.elastano) conf -= 4;
    }
    if (!corpo.formatoCorpo || corpo.formatoCorpo === 'naosei') conf -= 6;
    if (!corpo.busto || !corpo.quadril) conf -= 4;
    if (fracao >= 0.35) conf -= 10;
    else if (fracao >= 0.2) conf -= 4;
    if ((aprend.amostrasRef || 0) >= 8) conf += 6;
    else if ((aprend.amostrasRef || 0) >= 3) conf += 3;
    if ((aprend.taxaTroca || 0) > 0.15) conf -= 8;
    if (ajustadoPorEstoque) conf -= 6;
    conf = Math.max(40, Math.min(99, Math.round(conf)));

    // ── TEXTO PRA CLIENTE ─────────────────────────────────────────────────
    const frases: string[] = [];
    if (peca.modelagem === 'pequena') frases.push('Essa peça tem modelagem menor — já subimos um número pra você.');
    else if (peca.modelagem === 'grande') frases.push('Essa peça tem modelagem maior que o normal.');
    else if (peca.modelagem === 'normal') frases.push('Essa peça possui modelagem confortável.');

    if (peca.elastano === 'muito') frases.push('O tecido tem bastante elastano e cede bem no corpo.');
    else if (peca.elastano === 'pouco') frases.push('O tecido possui elastano.');
    else if (peca.elastano === 'sem') frases.push('O tecido não tem elastano — considere um número acima se gostar de folga.');

    if (peca.caimento === 'amplo') frases.push('O caimento é amplo e soltinho.');
    else if (peca.caimento === 'justo') frases.push('O caimento é mais justo ao corpo.');

    frases.push(`Recomendamos o tamanho ${tamanho}.`);
    if (tamanhoAlt && direcaoAlt > 0) frases.push(`Se preferir mais soltinha, escolha o ${tamanhoAlt}.`);
    else if (tamanhoAlt) frases.push(`Se preferir mais justinha, escolha o ${tamanhoAlt}.`);
    if ((aprend.amostrasRef || 0) >= 3 && Math.abs(viesRef) >= 0.3) {
      frases.push('Ajustamos pela experiência real de quem já comprou essa peça.');
    }
    if (baseBruta < -0.75 && !temHabitual) {
      frases.push('O 46 é o menor número da nossa grade — se você costuma vestir 44, pode ficar levemente amplo.');
    }

    return {
      tamanho,
      tamanhoAlt,
      confianca: conf,
      estrelas: Math.max(1, Math.min(5, Math.round(conf / 20))),
      falarComConsultora: conf < 80,
      titulo: `Seu tamanho ideal é ${tamanho}`,
      frases,
      trilha,
    };
  }

  /**
   * Converte um desfecho real em PASSOS de correção pro modelo aprender.
   * Comprou 54 e trocou pelo 56 → +1 (a peça veste pequeno).
   */
  passosEntre(de?: string | null, para?: string | null): number | null {
    const a = this.indiceDe(de);
    const b = this.indiceDe(para);
    if (a === null || b === null) return null;
    return b - a;
  }
}
