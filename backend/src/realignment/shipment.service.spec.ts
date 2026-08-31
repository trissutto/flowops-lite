import { RealignmentShipmentService } from './shipment.service';

/**
 * A RÉGUA DA TROCA DE PEÇA (31/08/2026), na ordem em que errar doeria.
 *
 * O caso que criou isto: REM-2026-000852 (LIMEIRA → SÃO JOSÉ DOS CAMPOS) ficou
 * 26 dias travada por 1 peça. A caixa pedia `124131 GOIABA 54` (7891426031883)
 * e veio `124131 ROSE 54` (7891426031890) — mesma REF, mesmo tamanho, dois
 * rosas quase idênticos e código de barras VIZINHO. O bipe casa REF+COR+TAM,
 * então recusou; a única saída na tela era "Faltante", que é mentira: a peça
 * chegou, só não era essa.
 *
 * Aceitar a troca errada é PIOR que recusar o bipe: some uma peça do estoque
 * de uma loja e nasce outra na de outra. Por isso as travas abaixo, e por isso
 * o padrão é NÃO trocar sempre que sobrar dúvida.
 *
 *   1. Só troca com REF (pela base, sem o sufixo de letra da cor) e TAMANHO
 *      idênticos — cor é o ÚNICO campo que pode divergir.
 *   2. Cor tem que estar resolvida nos dois lados. Cor vazia não é "outra cor",
 *      é falta de informação.
 *   3. SKU que já é de outro item da caixa nunca é troca — é re-bipe ou peça
 *      repetida, e trocar apagaria um item legítimo.
 *   4. Empate não troca: dois pendentes da mesma REF+TAM em cores diferentes
 *      não dizem qual a origem trocou.
 *   5. Item já recebido/faltante não entra na disputa.
 */
describe('troca de peça no recebimento — acharCandidatoTroca', () => {
  // O método é puro: não toca em Prisma, ERP nem gateway. Instanciar com as
  // dependências nulas é de propósito — se um dia ele começar a consultar
  // banco, este teste explode, que é o aviso certo.
  const svc = new RealignmentShipmentService(
    null as any, null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any,
  );
  const achar = (info: any, pendentes: any[], todos?: any[], sku = '7891426031890') =>
    (svc as any).acharCandidatoTroca(info, pendentes, todos ?? pendentes, sku);

  const GOIABA54 = {
    id: 'item-goiaba',
    refCode: '124131',
    cor: 'GOIABA',
    tamanho: '54',
    codigoBipado: '7891426031883',
  };
  const ROSE54 = { ref: '124131', cor: 'ROSE', tamanho: '54' };

  it('o caso REM-2026-000852: mesma REF e tamanho, cor diferente → troca', () => {
    const achado = achar(ROSE54, [GOIABA54]);
    expect(achado?.id).toBe('item-goiaba');
  });

  it('REF com sufixo de letra da cor casa pela base (12608V ↔ 12608)', () => {
    const achado = achar(
      { ref: '12608V', cor: 'VINHO', tamanho: '46' },
      [{ id: 'i1', refCode: '12608', cor: 'PRETO', tamanho: '46', codigoBipado: '111' }],
    );
    expect(achado?.id).toBe('i1');
  });

  it('tamanho diferente NUNCA troca — é outra peça, não outra cor', () => {
    expect(achar({ ...ROSE54, tamanho: '52' }, [GOIABA54])).toBeNull();
  });

  it('REF diferente NUNCA troca', () => {
    expect(achar({ ...ROSE54, ref: '124133' }, [GOIABA54])).toBeNull();
  });

  it('mesma cor não é troca — é falha de match, e o erro seco tem que aparecer', () => {
    expect(achar({ ...ROSE54, cor: 'GOIABA' }, [GOIABA54])).toBeNull();
  });

  it('cor não resolvida em qualquer um dos lados não troca', () => {
    expect(achar({ ...ROSE54, cor: null }, [GOIABA54])).toBeNull();
    expect(achar(ROSE54, [{ ...GOIABA54, cor: null }])).toBeNull();
  });

  it('SKU nao encontrado no catálogo (info null) não troca', () => {
    expect(achar(null, [GOIABA54])).toBeNull();
  });

  it('SKU que já é de outro item da caixa é re-bipe, não troca', () => {
    const outroJaRecebido = {
      id: 'item-rose-legitimo',
      refCode: '124131',
      cor: 'ROSE',
      tamanho: '54',
      codigoBipado: '7891426031890',
    };
    // Pendente existe e casaria pela regra de cor — mas o SKU já pertence a
    // outro item da remessa. Trocar aqui apagaria a peça legítima.
    expect(achar(ROSE54, [GOIABA54], [GOIABA54, outroJaRecebido])).toBeNull();
  });

  it('SKU do outro item casa mesmo com zero à esquerda', () => {
    const outro = { id: 'x', refCode: '124131', cor: 'ROSE', tamanho: '54', codigoBipado: '007891426031890' };
    expect(achar(ROSE54, [GOIABA54], [GOIABA54, outro])).toBeNull();
  });

  it('empate (dois pendentes da mesma REF+TAM) não troca nenhum', () => {
    const preto54 = { id: 'item-preto', refCode: '124131', cor: 'PRETO', tamanho: '54', codigoBipado: '7891426031869' };
    expect(achar(ROSE54, [GOIABA54, preto54])).toBeNull();
  });

  it('só disputa quem está pendente — recebido/faltante já saiu da lista', () => {
    // A lista de pendentes chega filtrada do scanItem; aqui garante que um
    // pendente único continua único mesmo com a caixa cheia de recebidos.
    const recebidos = [
      { id: 'r1', refCode: '124131', cor: 'CACAU', tamanho: '54', codigoBipado: '11037736' },
      { id: 'r2', refCode: '124131', cor: 'PRETO', tamanho: '54', codigoBipado: '7891426031869' },
    ];
    const achado = achar(ROSE54, [GOIABA54], [GOIABA54, ...recebidos]);
    expect(achado?.id).toBe('item-goiaba');
  });

  it('compara cor e tamanho sem se importar com espaço e caixa', () => {
    const achado = achar(
      { ref: ' 124131 ', cor: ' rose ', tamanho: ' 54 ' },
      [{ ...GOIABA54, cor: ' goiaba ', tamanho: '54 ' }],
    );
    expect(achado?.id).toBe('item-goiaba');
  });
});
