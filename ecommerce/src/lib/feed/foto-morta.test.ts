/**
 * A REDE DA BORDA CONTRA A FOTO DO WORDPRESS APAGADO.
 *
 * Medido em 14/09/2026: 48 dos 945 itens de `/feed/google.xml` (e os mesmos 48
 * no `/feed/meta.xml`) saíam com `<g:image_link>` em
 * `lurds.com.br/wp-content/...`, mais 152 `additional_image_link`. Esse
 * caminho responde **403** desde que a KingHost apagou o WordPress (27/08), e
 * item com imagem que não abre é reprovado pelo Google.
 *
 * A cura mora no backend (`common/foto-viva.ts`): a peça sai do catálogo. Aqui
 * se fixa a rede — enquanto backend e site estiverem em deploys diferentes, ou
 * o feed estiver cacheado, o item quebrado não passa.
 *
 * ⚠️ O `id` de quem SOBREVIVE não pode mudar: id novo faz o Google tratar como
 * produto novo e o histórico do Shopping recomeça do zero.
 */

import { describe, expect, it } from 'vitest';

import { variantes, type PecaFeed } from './variantes';

const WP = 'https://lurds.com.br/wp-content/uploads/2026/03/700906-CHUMBO-4-1.avif';
const R2 = 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/produtos/3153/CREME/1.jpg';

const peca = (over: Partial<PecaFeed> = {}): PecaFeed => ({
  ref: '700906',
  slug: 'ref-700906',
  nome: 'Blusa Manga Curta',
  descricao: null,
  marca: 'MALWEE',
  categoria: 'blusas',
  subcategoria: 'manga-curta',
  preco: 129.9,
  precoPromocional: null,
  disponivel: true,
  imagens: [],
  tamanhos: ['46', '48'],
  cores: ['CHUMBO'],
  ...over,
});

describe('foto morta no feed', () => {
  it('descarta a capa do WP e promove a próxima válida — o id NÃO muda', () => {
    const [v, ...resto] = variantes(peca({ imagens: [WP, R2] }));
    expect(resto).toEqual([]);
    expect(v.id).toBe('700906');
    expect(v.fotos).toEqual([R2]);
  });

  it('peça com a galeria 100% no WP não sai no feed — é o caso das 48', () => {
    expect(variantes(peca({ imagens: [WP, `${WP}?x=2`] }))).toEqual([]);
  });

  it('peça sem foto nenhuma também não sai — item sem imagem é reprovado', () => {
    expect(variantes(peca({ imagens: [] }))).toEqual([]);
  });

  it('cor cuja galeria é toda do WP não vira item com id novo', () => {
    const vars = variantes(
      peca({
        imagens: [R2],
        coresDetalhe: [
          { nome: 'CHUMBO', estoque: 10, preco: 129.9, fotos: [R2], tamanhos: ['46'] },
          { nome: 'VINHO', estoque: 30, preco: 129.9, fotos: [WP], tamanhos: ['48'] },
        ],
      }),
    );
    // Sobrou UMA cor com foto viva: volta a ser item único, com o id da REF.
    expect(vars.map((v) => v.id)).toEqual(['700906']);
  });

  it('duas cores com foto viva continuam explodindo, maior estoque com o id da REF', () => {
    const vars = variantes(
      peca({
        imagens: [R2],
        coresDetalhe: [
          { nome: 'CHUMBO', estoque: 10, preco: 129.9, fotos: [WP, R2], tamanhos: ['46'] },
          { nome: 'VINHO', estoque: 30, preco: 129.9, fotos: [R2], tamanhos: ['48'] },
        ],
      }),
    );
    expect(vars.map((v) => v.id)).toEqual(['700906', '700906-CHUMBO']);
    expect(vars[0].cor).toBe('VINHO');
    // A capa da CHUMBO era do WP: sobrou só a viva, na ordem original.
    expect(vars[1].fotos).toEqual([R2]);
  });

  it('o corte é pelo CAMINHO, não pelo host — o site vivo é lurds.com.br', () => {
    const proprio = 'https://lurds.com.br/produtos/700906/CHUMBO/1.jpg';
    expect(variantes(peca({ imagens: [proprio] }))[0].fotos).toEqual([proprio]);
  });
});
