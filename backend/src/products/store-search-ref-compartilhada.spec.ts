/**
 * REF COMPARTILHADA POR PRODUTOS DIFERENTES na Consulta (/minha-loja/consultar).
 *
 * 10/09/2026, foto do dono (loja 01 Itanhaém): a grade da REF 22 dizia 23
 * peças no tamanho 14 BRANCA e a arara tinha ZERO camiseta manga curta 14.
 * A REF 22 é o uniforme do colégio: camiseta manga curta, camiseta manga
 * longa e regata dividem a MESMA REF, o MESMO fornecedor (CNPJ
 * 04752209000162) e NENHUMA tem marca. O balde do cartão caía da MARCA vazia
 * pro FORNECEDOR, e os três produtos viravam UM cartão — batizado pelo
 * primeiro código, "CAMISETA MANGA CURTA 22 DE ABRIL" — com 2+ variantes na
 * mesma cor×tamanho. A célula do 14 mostrava a REGATA (23) e a linha Total
 * somava regata + manga longa (32); a camiseta manga curta 14, zerada, nem
 * entrava (a dedup do catálogo fica com o código de mais estoque).
 *
 * Regra que estes testes prendem: marca vazia NÃO cai pro CNPJ — cai pra
 * família da descrição (`discriminadorProduto`), a MESMA chave da dedup do
 * catálogo. Resultado: cada cor×tamanho aparece UMA vez por cartão, e a
 * célula não tem como divergir da linha Total.
 */
import { ProductsService } from './products.service';

const CNPJ = '04752209000162';
// Linhas como o catálogo devolve DEPOIS da dedup (manga curta 14 = 0 já saiu
// perdendo pra manga longa 14 = 9 na chave `22|~camiseta|BRANCA|14`).
const UNIFORME_REF_22 = [
  { CODIGO: '184861', REF: '22', COR: 'BRANCA', TAMANHO: '01', DESCRICAOCOMPLETA: 'CAMISETA MANGA CURTA 22 DE ABRIL BRANCA 01', VENDAUN: 49.9, MARCA: null, FORNECEDOR: CNPJ },
  { CODIGO: '10016', REF: '22', COR: 'BRANCA', TAMANHO: '14', DESCRICAOCOMPLETA: 'CAMISETA MANGA LONGA 22 DE ABRIL BRANCA 14', VENDAUN: 59.9, MARCA: null, FORNECEDOR: CNPJ },
  { CODIGO: '220910', REF: '22', COR: 'BRANCA', TAMANHO: '01', DESCRICAOCOMPLETA: 'REGATA 22 DE ABRIL BRANCA 01', VENDAUN: 49.9, MARCA: null, FORNECEDOR: CNPJ },
  { CODIGO: '9959', REF: '22', COR: 'BRANCA', TAMANHO: '14', DESCRICAOCOMPLETA: 'REGATA 22 DE ABRIL BRANCA 14', VENDAUN: 59.9, MARCA: null, FORNECEDOR: CNPJ },
];
const ESTOQUE_ITANHAEM: Record<string, Array<{ storeCode: string; qty: number }>> = {
  '184861': [{ storeCode: '01', qty: 25 }],
  '10016': [{ storeCode: '01', qty: 9 }],
  '220910': [{ storeCode: '01', qty: 20 }],
  '9959': [{ storeCode: '01', qty: 23 }],
};

function montar(over: { searchByRef?: any[]; estoque?: Record<string, Array<{ storeCode: string; qty: number }>> }) {
  const catalog = {
    searchByRefSemGiga: jest.fn().mockResolvedValue(over.searchByRef ?? []),
    searchByCodeAndExpandRefSemGiga: jest.fn().mockResolvedValue([]),
    searchByRef: jest.fn().mockResolvedValue([]),
    searchByCodeAndExpandRef: jest.fn().mockResolvedValue([]),
    searchByDescriptionGrouped: jest.fn().mockResolvedValue([]),
    getStockBySkusDetailed: jest.fn().mockResolvedValue(over.estoque ?? {}),
  };
  const buscaUnica = { resolveRows: jest.fn().mockResolvedValue([]) };
  const vazio = { findMany: jest.fn().mockResolvedValue([]) };
  const prisma = {
    store: {
      findUnique: jest.fn().mockResolvedValue({ id: 'loja-itanhaem', code: '01', name: 'ITANHAÉM' }),
      findMany: jest.fn().mockResolvedValue([{ code: '01', name: 'ITANHAÉM', whatsapp: null }]),
    },
    product: vazio,
    wincredProduto: vazio,
    gigaProduto: vazio,
  };
  const service = new ProductsService(
    {} as any, { get: () => undefined } as any, {} as any,
    catalog as any, buscaUnica as any, prisma as any,
  );
  return { service, catalog };
}

/** Nenhum cartão pode ter a mesma cor×tamanho duas vezes — é isso que fazia a célula mentir. */
function corTamanhoRepetido(card: { variants: Array<{ cor: string; tamanho: string }> }) {
  const vistos = new Set<string>();
  for (const v of card.variants) {
    const k = `${v.cor}|${v.tamanho}`;
    if (vistos.has(k)) return k;
    vistos.add(k);
  }
  return null;
}

describe('store-search — REF compartilhada por produtos diferentes (caso REF 22)', () => {
  it('marca vazia + mesmo fornecedor: camiseta e regata viram cartões SEPARADOS, sem cor×tamanho repetida', async () => {
    const { service } = montar({ searchByRef: UNIFORME_REF_22, estoque: ESTOQUE_ITANHAEM });

    const r = await service.storeProductSearch('22', 'loja-itanhaem', 'ref');

    expect(r.results).toHaveLength(2);
    for (const card of r.results) {
      expect(card.ref).toBe('22');
      expect(corTamanhoRepetido(card)).toBeNull();
      // O CNPJ não pode ser o rótulo do cartão (era o que aparecia no cabeçalho: "REF 22 · 04752209000162").
      expect(card.marca ?? '').not.toContain(CNPJ);
    }

    const camiseta = r.results.find((c) => c.name.startsWith('CAMISETA'))!;
    const regata = r.results.find((c) => c.name.startsWith('REGATA'))!;
    expect(camiseta).toBeDefined();
    expect(regata).toBeDefined();

    // Tamanho 14 BRANCA: a camiseta mostra os 9 da manga longa, a regata os 23 — nunca 23 (ou 32) na camiseta.
    const cam14 = camiseta.variants.find((v) => v.tamanho === '14')!;
    const reg14 = regata.variants.find((v) => v.tamanho === '14')!;
    expect(cam14.myStoreQty).toBe(9);
    expect(reg14.myStoreQty).toBe(23);
    expect(camiseta.myStoreTotal).toBe(25 + 9);
    expect(regata.myStoreTotal).toBe(20 + 23);
  });

  it('marca vazia + mesma família de descrição: NÃO racha (mesmo com o CNPJ gravado diferente — caso BMM-100 sem marca)', async () => {
    // O motivo de a marca ter substituído o fornecedor em 03/08: o mesmo
    // fornecedor entra com CNPJ escrito de dois jeitos entre cadastros. Com
    // a marca vazia, a família da descrição precisa segurar isso sozinha.
    const { service } = montar({
      searchByRef: [
        { CODIGO: '1', REF: '5100', COR: 'PRETO', TAMANHO: '46', DESCRICAOCOMPLETA: 'VESTIDO MIDI 5100 PRETO 46', VENDAUN: 199.9, MARCA: '', FORNECEDOR: '20104813000139' },
        { CODIGO: '2', REF: '5100', COR: 'PRETO', TAMANHO: '48', DESCRICAOCOMPLETA: 'VESTIDO MIDI 5100 PRETO 48', VENDAUN: 199.9, MARCA: '', FORNECEDOR: '20.104.813/0001-39' },
      ],
      estoque: { '1': [{ storeCode: '01', qty: 1 }], '2': [{ storeCode: '01', qty: 2 }] },
    });

    const r = await service.storeProductSearch('5100', 'loja-itanhaem', 'ref');

    expect(r.results).toHaveLength(1);
    expect(r.results[0].variants).toHaveLength(2);
    expect(r.results[0].myStoreTotal).toBe(3);
  });

  it('com MARCA preenchida, a marca continua mandando (REF reciclada entre fornecedores segue separada)', async () => {
    const { service } = montar({
      searchByRef: [
        { CODIGO: '10', REF: '8709', COR: 'AZUL', TAMANHO: '44', DESCRICAOCOMPLETA: 'CALÇA 8709 AZUL 44 MANIFESTO', VENDAUN: 149.9, MARCA: 'MANIFESTO', FORNECEDOR: 'A' },
        { CODIGO: '11', REF: '8709', COR: 'AZUL', TAMANHO: '44', DESCRICAOCOMPLETA: 'VESTIDO 8709 AZUL 44 RIU KIU', VENDAUN: 189.9, MARCA: 'RIU KIU', FORNECEDOR: 'A' },
      ],
    });

    const r = await service.storeProductSearch('8709', 'loja-itanhaem', 'ref');

    expect(r.results).toHaveLength(2);
    expect(r.results.map((c) => c.marca).sort()).toEqual(['MANIFESTO', 'RIU KIU']);
  });
});
