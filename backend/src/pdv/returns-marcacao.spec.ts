import { BadRequestException } from '@nestjs/common';
import { ReturnsService } from './returns.service';

/**
 * MARCAÇÃO NÃO É VENDA — a regra do dono, 31/08/2026:
 *
 *   "estou falando da modalidade MARCADOS onde a pessoa leva para experimentar.
 *    ao devolver simplesmente devolve e pronto. NÃO gera crédito nem vale troca
 *    nem nada."
 *
 * O buraco: a marcação é gravada como `PdvSale` **finalized** com
 * `paymentMethod='MARCADO'` e ZERO pagamento (`criarMarcadoFromSale`). A
 * devolução só perguntava o status — então a marcação entrava na tela de
 * devolução do PDV como venda devolvível e emitia VALE DE TROCA pelo valor
 * cheio da peça. A cliente saía com crédito de um dinheiro que nunca entrou.
 *
 * Medido em 31/08: 3 vales, R$ 173,70 — valor do vale IGUAL ao da marcação nos
 * três (R$ 69,90 / R$ 79,90 / R$ 23,90), um já gasto. E 204 marcações em 60
 * dias (R$ 89.879,12) estavam expostas ao mesmo caminho.
 *
 * Duas travas, porque uma só não resolve:
 *   1. a marcação não pode nem APARECER na busca por SKU da tela (senão a
 *      vendedora escolhe e toma erro na cara da cliente);
 *   2. e mesmo que chegue lá por outro caminho, `createReturn` recusa.
 */
describe('devolução — marcação não é venda devolvível', () => {
  const svc = new ReturnsService(
    null as any, null as any, null as any, null as any,
  );
  const carregar = (sale: any) => (svc as any).carregarVendaDevolvivel.call(
    { prisma: { pdvSale: { findUnique: async () => sale } } },
    'sale-1',
  );

  const vendaPaga = {
    id: 'sale-1', status: 'finalized', paymentMethod: 'credito', items: [],
  };
  const marcacao = {
    id: 'sale-1', status: 'finalized', paymentMethod: 'MARCADO', items: [],
  };

  it('venda de verdade passa', async () => {
    await expect(carregar(vendaPaga)).resolves.toMatchObject({ origem: 'pdv' });
  });

  it('MARCAÇÃO é recusada — mesmo estando finalized', async () => {
    await expect(carregar(marcacao)).rejects.toThrow(BadRequestException);
  });

  it('o erro manda pra tela certa, não só diz "não pode"', async () => {
    // A vendedora está com a cliente na frente: a mensagem tem que dizer PARA
    // ONDE ir, senão ela procura outro jeito — que foi como isto começou.
    await expect(carregar(marcacao)).rejects.toThrow(/Marcados/i);
    await expect(carregar(marcacao)).rejects.toThrow(/Devolver ao estoque/i);
  });

  it('reconhece MARCADO com espaço e caixa diferente', async () => {
    await expect(carregar({ ...marcacao, paymentMethod: ' marcado ' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('venda sem paymentMethod não é confundida com marcação', async () => {
    // `troca_par` e vendas antigas podem vir sem método — não podem cair na
    // trava, senão a devolução legítima para de funcionar.
    await expect(carregar({ ...vendaPaga, paymentMethod: null })).resolves.toMatchObject({
      origem: 'pdv',
    });
  });

  it('status não-finalized continua sendo recusado antes de tudo', async () => {
    await expect(carregar({ ...vendaPaga, status: 'open' })).rejects.toThrow(/open/);
  });
});
