import { blocoDaPeca, ordenarGradeDaCategoria } from './ordem-por-subcategoria';

/**
 * O CASO REAL: /categoria/linha-conforto em 31/08/2026 — 36 blusas e 3
 * vestidos, ordenados por novidade, com os vestidos caindo no meio.
 */
const ORDEM = ['blusas-conforto', 'vestidos-conforto'];

// Como as peças estão MESMO no banco (conferido em produção, 31/08):
const vogue = { ref: 'VOGUE', subcategoria: null, subcategoriasExtras: ['blusas-conforto', 'manga-curta'] };
const bmm100 = { ref: 'BMM-100', subcategoria: 'blusas-conforto', subcategoriasExtras: ['manga-curta'] };
const vlm222 = { ref: 'VLM-222', subcategoria: 'vestido-manga-curta', subcategoriasExtras: ['vestidos-conforto'] };
const vms223 = { ref: 'VMS-223', subcategoria: 'vestido-sem-manga', subcategoriasExtras: ['vestidos-conforto'] };
const solta = { ref: 'NOVA', subcategoria: null, subcategoriasExtras: [] };

const refs = (l: Array<{ ref: string }>) => l.map((p) => p.ref);

describe('blocoDaPeca', () => {
  it('acha a subcategoria da campanha nas EXTRAS — é onde ela vive', () => {
    // A principal do VOGUE é da árvore de *Blusas*; sem olhar as extras, 31
    // das 36 blusas ficariam fora de qualquer bloco.
    expect(blocoDaPeca(vogue, ORDEM)).toBe(0);
    expect(blocoDaPeca(bmm100, ORDEM)).toBe(0);
    expect(blocoDaPeca(vlm222, ORDEM)).toBe(1);
  });

  it('peça fora das subcategorias vai pro fim, não pro começo', () => {
    expect(blocoDaPeca(solta, ORDEM)).toBe(ORDEM.length);
  });

  it('marcada nas duas famílias cai na primeira da ordem', () => {
    const hibrida = { ref: 'X', subcategoria: 'vestidos-conforto', subcategoriasExtras: ['blusas-conforto'] };
    expect(blocoDaPeca(hibrida, ORDEM)).toBe(0);
  });

  it('não se importa com caixa nem espaço', () => {
    expect(blocoDaPeca({ subcategoria: '  Blusas-Conforto ' }, ORDEM)).toBe(0);
  });
});

describe('ordenarGradeDaCategoria — só os blocos', () => {
  const grade = (l: any[]) => refs(ordenarGradeDaCategoria(l, { subs: ORDEM }));

  it('blusa SEMPRE antes de vestido — o pedido do dono', () => {
    expect(grade([vlm222, vogue, vms223, bmm100])).toEqual([
      'VOGUE', 'BMM-100', 'VLM-222', 'VMS-223',
    ]);
  });

  it('DENTRO do bloco a ordem de quem chamou fica de pé (sort estável)', () => {
    // Entram na ordem de novidade; a novidade tem de continuar abrindo cada
    // bloco — senão mudar a ordem da grade custaria a ordem da vitrine.
    expect(grade([vogue, vlm222, bmm100, vms223])).toEqual([
      'VOGUE', 'BMM-100', 'VLM-222', 'VMS-223',
    ]);
  });

  it('a peça sem classificação aparece — depois de todo mundo', () => {
    expect(grade([solta, vlm222, vogue])).toEqual(['VOGUE', 'VLM-222', 'NOVA']);
  });

  it('inverter a ordem das subcategorias inverte a grade', () => {
    // É a `ordem` do SiteCategoria que manda: mudar o número na retaguarda
    // tem de mudar a página, sem deploy.
    const invertida = ordenarGradeDaCategoria([vogue, vlm222], {
      subs: ['vestidos-conforto', 'blusas-conforto'],
    });
    expect(refs(invertida)).toEqual(['VLM-222', 'VOGUE']);
  });

  it('categoria sem subcategoria configurada e sem curadoria não é tocada', () => {
    expect(refs(ordenarGradeDaCategoria([vlm222, vogue, solta], {}))).toEqual([
      'VLM-222', 'VOGUE', 'NOVA',
    ]);
  });
});

/**
 * A CURADORIA CONTINUA VALENDO — DENTRO DA FAMÍLIA (31/08).
 *
 * A ordem manual gravada da Linha Conforto abria com VMS-223 e VLM-222, os
 * dois vestidos. Se a posição vencesse o bloco, ligar o agrupamento não
 * mudaria nada na página e o botão novo pareceria quebrado.
 */
describe('ordenarGradeDaCategoria — bloco × ordem manual', () => {
  // A gravada de verdade em `ordem-categoria-linha-conforto`, encurtada.
  const MANUAL = ['VMS-223', 'VLM-222', 'BMM-100', 'VOGUE'];
  const posicao = (p: any) => {
    const i = MANUAL.indexOf(p.ref);
    return i < 0 ? null : i;
  };

  it('o bloco ganha: os vestidos posicionados em 1º e 2º vão pro fim', () => {
    const saida = ordenarGradeDaCategoria([vms223, vlm222, bmm100, vogue], {
      subs: ORDEM,
      posicaoManual: posicao,
    });
    expect(refs(saida)).toEqual(['BMM-100', 'VOGUE', 'VMS-223', 'VLM-222']);
  });

  it('e a curadoria sobrevive DENTRO de cada família', () => {
    // BMM-100 antes de VOGUE porque é isso que a ordem manual diz; VMS-223
    // antes de VLM-222 pelo mesmo motivo. Nenhuma das duas escolhas se perdeu.
    const saida = ordenarGradeDaCategoria([vogue, vlm222, vms223, bmm100], {
      subs: ORDEM,
      posicaoManual: posicao,
    });
    expect(refs(saida)).toEqual(['BMM-100', 'VOGUE', 'VMS-223', 'VLM-222']);
  });

  it('peça fora da curadoria entra depois das posicionadas, no bloco dela', () => {
    const outraBlusa = { ref: 'SMILE', subcategoria: null, subcategoriasExtras: ['blusas-conforto'] };
    const saida = ordenarGradeDaCategoria([outraBlusa, vlm222, bmm100], {
      subs: ORDEM,
      posicaoManual: posicao,
    });
    expect(refs(saida)).toEqual(['BMM-100', 'SMILE', 'VLM-222']);
  });

  it('sem agrupamento a ordem manual segue mandando sozinha (o de 20/08)', () => {
    const saida = ordenarGradeDaCategoria([vogue, vms223, bmm100], { posicaoManual: posicao });
    expect(refs(saida)).toEqual(['VMS-223', 'BMM-100', 'VOGUE']);
  });
});
