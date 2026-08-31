import { blocoDaPeca, ordenarPorSubcategoria } from './ordem-por-subcategoria';

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

describe('ordenarPorSubcategoria', () => {
  it('blusa SEMPRE antes de vestido — o pedido do dono', () => {
    const grade = [vlm222, vogue, vms223, bmm100];
    expect(refs(ordenarPorSubcategoria(grade, ORDEM))).toEqual([
      'VOGUE', 'BMM-100', 'VLM-222', 'VMS-223',
    ]);
  });

  it('DENTRO do bloco a ordem de quem chamou fica de pé (sort estável)', () => {
    // Entram na ordem de novidade; a novidade tem de continuar abrindo cada
    // bloco — senão trocar a ordem da grade custaria a ordem da vitrine.
    const porNovidade = [vogue, vlm222, bmm100, vms223];
    expect(refs(ordenarPorSubcategoria(porNovidade, ORDEM))).toEqual([
      'VOGUE', 'BMM-100', 'VLM-222', 'VMS-223',
    ]);
  });

  it('a peça sem classificação aparece — depois de todo mundo', () => {
    const grade = [solta, vlm222, vogue];
    expect(refs(ordenarPorSubcategoria(grade, ORDEM))).toEqual(['VOGUE', 'VLM-222', 'NOVA']);
  });

  it('inverter a ordem das subcategorias inverte a grade', () => {
    // É a `ordem` do SiteCategoria que manda: mudar o número na retaguarda
    // tem de mudar a página, sem deploy.
    const grade = [vogue, vlm222];
    expect(refs(ordenarPorSubcategoria([...grade], ['vestidos-conforto', 'blusas-conforto'])))
      .toEqual(['VLM-222', 'VOGUE']);
  });

  it('categoria sem subcategoria configurada não é tocada', () => {
    const grade = [vlm222, vogue, solta];
    expect(refs(ordenarPorSubcategoria(grade, []))).toEqual(['VLM-222', 'VOGUE', 'NOVA']);
  });
});
