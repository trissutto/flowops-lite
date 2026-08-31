import {
  HORAS_PENDENTE,
  STATUS_QUE_RESERVAM,
  diasDeReserva,
  reservaLigada,
  sqlDisponivel,
  sqlReservadoPorSku,
  vitrineDescontaReserva,
} from './estoque-reservado';

/**
 * A régua que a VITRINE e o GUARDA DO CARRINHO leem juntos. O que estes testes
 * protegem não é o SQL bonito — é o fato de existir UM texto só. Enquanto eram
 * dois, a grade mostrava a peça e o checkout recusava no clique de pagar.
 */
describe('estoque-reservado', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('reserva só pedido pago e ainda não separado', () => {
    expect([...STATUS_QUE_RESERVAM]).toEqual([
      'processing',
      'routing',
      'awaiting_stock',
      'separating',
    ]);
    // Pedido sem dinheiro na conta não tira peça de ninguém (dono, 17/08).
    expect(HORAS_PENDENTE).toBe(0);
    expect([...STATUS_QUE_RESERVAM]).not.toContain('awaiting_payment');
    // Enviado/entregue já baixou o estoque — contar de novo tiraria duas vezes.
    expect([...STATUS_QUE_RESERVAM]).not.toContain('shipped');
    expect([...STATUS_QUE_RESERVAM]).not.toContain('delivered');
  });

  it('o SQL compartilhado não usa placeholder', () => {
    // Um `$1` aqui renumeraria os parâmetros do SQL_VARIACOES e quebraria toda
    // consulta do catálogo — é a razão de o filtro por SKU ficar por fora.
    expect(sqlReservadoPorSku()).not.toMatch(/\$\d/);
    expect(sqlReservadoPorSku()).toContain('order_items');
    expect(sqlReservadoPorSku()).toContain('GROUP BY oi.sku');
  });

  it('o teto de idade entra no SQL e o zero desliga', () => {
    delete process.env.CARRINHO_RESERVA_DIAS;
    expect(diasDeReserva()).toBe(15);
    expect(sqlReservadoPorSku()).toContain("INTERVAL '15 days'");

    process.env.CARRINHO_RESERVA_DIAS = '30';
    expect(sqlReservadoPorSku()).toContain("INTERVAL '30 days'");

    // Zero = sem teto: reserva de qualquer idade volta a contar.
    process.env.CARRINHO_RESERVA_DIAS = '0';
    expect(sqlReservadoPorSku()).toContain("TIMESTAMP 'epoch'");
  });

  it('CARRINHO_RESERVA=0 desliga os DOIS lados', () => {
    process.env.CARRINHO_RESERVA = '0';
    expect(reservaLigada()).toBe(false);
    // Desligar o guarda e deixar a vitrine descontando não faz sentido: ela
    // esconderia peça que o checkout venderia.
    expect(vitrineDescontaReserva()).toBe(false);
    expect(sqlDisponivel('e.total', 'r.qtd')).toBe('COALESCE(e.total, 0)::int');
  });

  it('VITRINE_ESTOQUE_RESERVADO=0 volta só a vitrine ao bruto', () => {
    delete process.env.CARRINHO_RESERVA;
    process.env.VITRINE_ESTOQUE_RESERVADO = '0';
    expect(reservaLigada()).toBe(true); // o checkout continua descontando
    expect(vitrineDescontaReserva()).toBe(false);
    expect(sqlDisponivel('e.total', 'r.qtd')).toBe('COALESCE(e.total, 0)::int');
  });

  it('ligada, a vitrine desconta com piso em zero', () => {
    delete process.env.CARRINHO_RESERVA;
    delete process.env.VITRINE_ESTOQUE_RESERVADO;
    expect(vitrineDescontaReserva()).toBe(true);
    // Sem o GREATEST, reserva maior que o estoque viraria "restam -3 peças".
    expect(sqlDisponivel('e.total', 'r.qtd')).toBe(
      'GREATEST(COALESCE(e.total, 0) - COALESCE(r.qtd, 0), 0)::int',
    );
  });
});
