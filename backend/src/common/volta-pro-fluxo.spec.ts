/**
 * A TRAVA DO LP-000210 (25/08/2026).
 *
 * Pedido concluído às 18:34 de 24/08 e `separating` de novo às 18:46 — 12
 * minutos depois, com card novo aberto em loja pra uma peça já postada.
 */
import { voltariaProFluxo, motivoDaRecusa } from './volta-pro-fluxo';

describe('voltariaProFluxo — pedido postado não volta pra arara', () => {
  const barrados: Array<[string, string]> = [
    ['shipped', 'separacao'],
    ['shipped', 'em-separacao'],
    ['shipped', 'processing'],
    ['delivered', 'separacao'],
    ['delivered', 'em-separacao'],
    ['delivered', 'processing'],
  ];
  it.each(barrados)('%s + pedido "%s" = RECUSA', (atual, pedido) => {
    expect(voltariaProFluxo(atual, pedido)).toBe(true);
  });

  const liberados: Array<[string, string, string]> = [
    // o caminho normal da operação continua inteiro
    ['processing', 'separacao', 'mandar separar o que ainda não separou'],
    ['separating', 'separacao', 'reenviar WhatsApp pra mesma loja'],
    ['separating', 'completed', 'a loja despachou'],
    ['shipped', 'completed', 'confirmar conclusão do que já saiu'],
    ['shipped', 'cancelled', 'cancelar/estornar tem porta própria'],
    ['delivered', 'completed', 'nada muda'],
    ['pending', 'processing', 'pagamento entrou'],
  ];
  it.each(liberados)('%s + pedido "%s" PASSA (%s)', (atual, pedido) => {
    expect(voltariaProFluxo(atual, pedido)).toBe(false);
  });

  it('não trava por caixa alta nem por espaço sobrando', () => {
    expect(voltariaProFluxo(' Shipped ', ' SEPARACAO ')).toBe(true);
  });

  it('sem status dos dois lados não opina — quem não sabe não barra', () => {
    expect(voltariaProFluxo(null, 'separacao')).toBe(false);
    expect(voltariaProFluxo('shipped', undefined)).toBe(false);
  });
});

describe('motivoDaRecusa — a tela precisa saber a saída, não só o não', () => {
  it('diz ENTREGUE quando entregue e DESPACHADO quando despachado', () => {
    expect(motivoDaRecusa('delivered')).toContain('ENTREGUE');
    expect(motivoDaRecusa('shipped')).toContain('DESPACHADO');
  });

  it('aponta a porta legítima em vez de deixar a matriz sem caminho', () => {
    expect(motivoDaRecusa('shipped')).toContain('Recalcular separação');
  });
});
