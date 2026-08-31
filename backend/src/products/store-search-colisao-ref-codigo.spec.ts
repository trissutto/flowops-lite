/**
 * COLISÃO REF × CÓDIGO na Consulta de Produto (/minha-loja/consultar).
 *
 * 31/08/2026, relatado pelo dono: a loja digitava `7023` (CALÇA PANTALONA
 * DIVAS, cadastrada 21/08, 76 peças em 14 lojas) e a tela devolvia a família
 * do REF 5604 — "nenhuma loja consegue puxar a calça nova da DIVAS".
 *
 * Causa: `7023` é REF da calça E CÓDIGO de uma blusa do REF 5604. O motor de
 * busca única resolve CÓDIGO primeiro e retorna na hora, então a REF homônima
 * nunca era consultada. O desempate "REF exata primeiro" já existia desde o
 * caso 223263 (03/08), mas atrás de um guard de 5+ dígitos — e a calça tem 4.
 *
 * Estes testes prendem a REGRA, não o número: qualquer termo só-dígitos.
 */
import { ProductsService } from './products.service';

// Linhas reais do espelho (wincred_produtos), conferidas em 31/08.
const CALCA_DIVAS_REF_7023 = [
  { CODIGO: '8000000022325', REF: '7023', COR: 'MARROM', TAMANHO: '46', DESCRICAOCOMPLETA: 'CALÇA FEMININA PANTALONA PLUS SIZE 7023 MARROM 46 DIVAS VOGA PLUS', VENDAUN: 279.9, MARCA: 'DIVAS VOGA PLUS' },
  { CODIGO: '8000000022332', REF: '7023', COR: 'MARROM', TAMANHO: '48', DESCRICAOCOMPLETA: 'CALÇA FEMININA PANTALONA PLUS SIZE 7023 MARROM 48 DIVAS VOGA PLUS', VENDAUN: 279.9, MARCA: 'DIVAS VOGA PLUS' },
];
// O sequestrador: CÓDIGO 7023 é uma blusa cuja REF é 5604.
const BLUSA_REF_5604_CODIGO_7023 = [
  { CODIGO: '7023', REF: '5604', COR: 'COLOR', TAMANHO: 'G', DESCRICAOCOMPLETA: 'BLUSA FEMININA MANGA LONGA 5604 RIU KIU COLOR G', VENDAUN: 89.9, MARCA: 'RIU KIU' },
];

function montar(over: {
  searchByRef?: any[];
  searchByCodeAndExpandRef?: any[];
  resolveRows?: any[];
}) {
  const catalog = {
    searchByRef: jest.fn().mockResolvedValue(over.searchByRef ?? []),
    searchByCodeAndExpandRef: jest.fn().mockResolvedValue(over.searchByCodeAndExpandRef ?? []),
    searchByDescriptionGrouped: jest.fn().mockResolvedValue([]),
    getStockBySkusDetailed: jest.fn().mockResolvedValue({}),
  };
  const buscaUnica = {
    resolveRows: jest.fn().mockResolvedValue(
      (over.resolveRows ?? []).map((r) => ({
        codigo: r.CODIGO, ref: r.REF, descricao: r.DESCRICAOCOMPLETA,
        cor: r.COR, tamanho: r.TAMANHO, vendaUn: r.VENDAUN, marca: r.MARCA,
      })),
    ),
  };
  const vazio = { findMany: jest.fn().mockResolvedValue([]) };
  const prisma = {
    store: {
      findUnique: jest.fn().mockResolvedValue({ id: 'loja-limeira', code: '11', name: 'LIMEIRA' }),
      findMany: jest.fn().mockResolvedValue([{ code: '11', name: 'LIMEIRA', whatsapp: null }]),
    },
    product: vazio,
    wincredProduto: vazio,
    gigaProduto: vazio,
  };
  const service = new ProductsService(
    {} as any, { get: () => undefined } as any, {} as any,
    catalog as any, buscaUnica as any, prisma as any,
  );
  return { service, catalog, buscaUnica };
}

const refsDe = (r: any) => r.results.map((x: any) => x.ref);

describe('store-search — colisão REF × CÓDIGO', () => {
  it('REF de 4 dígitos ganha do CÓDIGO homônimo (caso 7023: calça DIVAS × blusa 5604)', async () => {
    const { service, catalog, buscaUnica } = montar({
      searchByRef: CALCA_DIVAS_REF_7023,
      searchByCodeAndExpandRef: BLUSA_REF_5604_CODIGO_7023,
      resolveRows: BLUSA_REF_5604_CODIGO_7023,
    });

    const r = await service.storeProductSearch('7023', 'loja-limeira', 'ref');

    expect(refsDe(r)).toContain('7023');
    expect(refsDe(r)).not.toContain('5604');
    expect(catalog.searchByRef).toHaveBeenCalledWith('7023');
    // A busca única não pode ser a fonte de um termo numérico na aba REF —
    // é ela que resolve código antes de REF.
    expect(buscaUnica.resolveRows).not.toHaveBeenCalled();
  });

  it('mantém o fix do caso 223263 (6 dígitos), que já estava protegido', async () => {
    const { service } = montar({
      searchByRef: [{ CODIGO: '900001', REF: '223263', COR: 'PRETO', TAMANHO: '46', DESCRICAOCOMPLETA: 'VESTIDO 223263 MARRIE', VENDAUN: 199.9, MARCA: 'MARRIE' }],
      searchByCodeAndExpandRef: [{ CODIGO: '223263', REF: '6168', COR: 'AZUL', TAMANHO: '44', DESCRICAOCOMPLETA: 'CALÇA 6168', VENDAUN: 149.9, MARCA: 'X' }],
    });

    const r = await service.storeProductSearch('223263', 'loja-limeira', 'ref');

    expect(refsDe(r)).toContain('223263');
    expect(refsDe(r)).not.toContain('6168');
  });

  it('sem REF com esse número, o termo volta a ser etiqueta bipada na aba errada', async () => {
    const { service } = montar({
      searchByRef: [],
      searchByCodeAndExpandRef: BLUSA_REF_5604_CODIGO_7023,
    });

    const r = await service.storeProductSearch('7023', 'loja-limeira', 'ref');

    expect(refsDe(r)).toContain('5604');
    expect(r.results[0].matchedSku).toBe('7023');
  });

  it('REF textual (BMM-100) continua indo pela busca única', async () => {
    const { service, buscaUnica } = montar({
      resolveRows: [{ CODIGO: '555', REF: 'BMM-100', COR: 'VINHO', TAMANHO: '52', DESCRICAOCOMPLETA: 'BLUSA BMM-100 VINHO 52', VENDAUN: 99.9, MARCA: 'X' }],
    });

    const r = await service.storeProductSearch('BMM-100', 'loja-limeira', 'ref');

    expect(buscaUnica.resolveRows).toHaveBeenCalled();
    expect(refsDe(r)).toContain('BMM-100');
  });

  it('lista de REFs (modo desc) mostra a REF numérica junto do código homônimo', async () => {
    const { service } = montar({
      searchByRef: CALCA_DIVAS_REF_7023,
      resolveRows: BLUSA_REF_5604_CODIGO_7023,
    });

    // 4 dígitos não é promovido pra 'sku' (guard de 5+), então cai no modo desc.
    const r = await service.storeProductSearch('7023', 'loja-limeira', 'desc');

    const refs = (r.refMatches ?? []).map((m) => m.ref);
    expect(refs[0]).toBe('7023');
    expect(refs).toContain('5604');
  });
});
