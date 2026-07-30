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
 *   1. Base pelo corpo (IMC ajustado por altura)
 *   2. Âncora no tamanho que a cliente JÁ USA (sinal mais forte que existe)
 *   3. Ajuste da PEÇA (modelagem, elastano, caimento)
 *   4. Preferência de caimento da cliente (justa/normal/soltinha)
 *   5. Proporção do corpo por categoria (busto manda em cima, quadril embaixo)
 *   6. VIÉS APRENDIDO — o que as trocas reais dessa peça ensinaram
 *
 * Trabalha em ÍNDICE da grade (0=46 … 7=60), não no número: assim "meio
 * tamanho" tem significado e o arredondamento acontece só no fim.
 */

export const GRADE_PLUS = ['46', '48', '50', '52', '54', '56', '58', '60'];

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

/** Peças em que o BUSTO manda / em que o QUADRIL manda. */
const CATEGORIA_CIMA = /blusa|camisa|jaqueta|casaco|body|cropped|regata|blazer|top/i;
const CATEGORIA_BAIXO = /calca|calça|legging|saia|short|pantalona/i;
const CATEGORIA_INTEIRA = /vestido|macacao|macacão|conjunto/i;

@Injectable()
export class FitEngineService {
  /**
   * Base pelo corpo. Faixas calibradas pra grade PLUS feminina 46–60: o IMC
   * sozinho erra em quem é alta (mesmo peso distribuído em mais altura veste
   * menor), por isso a altura entra como correção fina.
   */
  private baseCorpo(alturaCm: number, pesoKg: number): { indice: number; imc: number } {
    const alturaM = Math.max(1.3, Math.min(2.1, alturaCm / 100));
    const imc = pesoKg / (alturaM * alturaM);

    const faixas: Array<[number, number]> = [
      [27, 0],    // até 27 → 46
      [29, 1],    // 48
      [31, 2],    // 50
      [33.5, 3],  // 52
      [36, 4],    // 54
      [39, 5],    // 56
      [42, 6],    // 58
    ];
    let indice = 7; // acima de 42 → 60
    for (const [teto, idx] of faixas) {
      if (imc < teto) { indice = idx; break; }
    }

    // Correção por altura: alta "estica" o volume, baixa concentra
    if (alturaCm >= 1.72 * 100) indice -= 0.5;
    else if (alturaCm >= 1.66 * 100) indice -= 0.25;
    else if (alturaCm <= 1.55 * 100) indice += 0.5;
    else if (alturaCm <= 1.60 * 100) indice += 0.25;

    return { indice: this.clamp(indice), imc };
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
    const { indice: baseImc, imc } = this.baseCorpo(corpo.alturaCm, corpo.pesoKg);
    let idx = baseImc;
    push('corpo', 0, idx, `IMC ${imc.toFixed(1)} + altura ${corpo.alturaCm}cm → ${GRADE_PLUS[Math.round(idx)]}`);

    // ── 2) ÂNCORA NO TAMANHO QUE ELA JÁ USA ───────────────────────────────
    // É o sinal mais forte do formulário: a cliente já viveu o corpo dela em
    // roupa. O IMC entra como contrapeso (ela pode estar comprando errado).
    const idxHabitual = this.indiceDe(corpo.tamanhoHabitual);
    const temHabitual = idxHabitual !== null;
    let discordancia = 0;
    if (temHabitual) {
      discordancia = Math.abs(idxHabitual! - baseImc);
      const antes = idx;
      idx = 0.45 * baseImc + 0.55 * idxHabitual!;
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
    if (corpo.preferencia === 'justa')    { idx -= 0.6; push('preferencia', -0.6, idx, 'prefere mais justa'); }
    if (corpo.preferencia === 'soltinha') { idx += 0.6; push('preferencia', +0.6, idx, 'prefere mais soltinha'); }

    // ── 5) PROPORÇÃO DO CORPO × CATEGORIA ─────────────────────────────────
    const cat = String(peca.categoria || '');
    const ehCima = CATEGORIA_CIMA.test(cat);
    const ehBaixo = CATEGORIA_BAIXO.test(cat);
    const ehInteira = CATEGORIA_INTEIRA.test(cat) || (!ehCima && !ehBaixo);

    const pesoBusto = ehCima ? 1 : ehInteira ? 0.6 : 0;
    const pesoQuadril = ehBaixo ? 1 : ehInteira ? 0.6 : 0;

    if (corpo.busto === 'G' && pesoBusto) { const a = 0.5 * pesoBusto; idx += a; push('busto', a, idx, 'busto grande'); }
    if (corpo.busto === 'P' && pesoBusto) { const a = -0.3 * pesoBusto; idx += a; push('busto', a, idx, 'busto pequeno'); }
    if (corpo.quadril === 'G' && pesoQuadril) { const a = 0.5 * pesoQuadril; idx += a; push('quadril', a, idx, 'quadril grande'); }
    if (corpo.quadril === 'P' && pesoQuadril) { const a = -0.3 * pesoQuadril; idx += a; push('quadril', a, idx, 'quadril pequeno'); }

    // Formato do corpo afina onde o volume se concentra
    if (corpo.formatoCorpo === 'pera' && (ehBaixo || ehInteira)) { idx += 0.3; push('formato', +0.3, idx, 'corpo pera — quadril manda'); }
    if (corpo.formatoCorpo === 'maca' && (ehCima || ehInteira))  { idx += 0.3; push('formato', +0.3, idx, 'corpo maçã — tronco manda'); }

    // ── 6) O QUE AS TROCAS REAIS ENSINARAM ────────────────────────────────
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
