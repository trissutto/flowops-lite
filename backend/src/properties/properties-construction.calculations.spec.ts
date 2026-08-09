import {
  buildConstructionSummary,
  buildLedger,
  paymentExceedsCommitment,
  reversalExceedsPayment,
} from './properties-construction.calculations';

describe('properties construction calculations', () => {
  const now = new Date('2026-08-08T12:00:00-03:00');

  it('calcula previsto, contratado, pagamentos parciais, estorno e entradas', () => {
    const summary = buildConstructionSummary({
      now,
      stages: [
        { id: 's1', budgetCents: 1_500_000, progressPercent: 50, status: 'em_andamento' },
        { id: 's2', budgetCents: 500_000, progressPercent: 100, status: 'concluida' },
      ],
      commitments: [
        { id: 'c1', amountCents: 1_200_000, dueDate: '2026-08-01', status: 'ativa' },
        { id: 'c2', amountCents: 300_000, dueDate: '2026-08-30', status: 'ativa' },
      ],
      payments: [
        {
          id: 'p1',
          commitmentId: 'c1',
          amountCents: 500_000,
          paidAt: '2026-07-10',
          reversals: [{ amountCents: 50_000, occurredAt: '2026-07-11' }],
        },
        { id: 'p2', commitmentId: 'c1', amountCents: 250_000, paidAt: '2026-08-01' },
      ],
      entries: [{ id: 'e1', type: 'aporte', amountCents: 1_000_000, occurredAt: '2026-07-01' }],
    });

    expect(summary).toEqual({
      previstoCents: 2_000_000,
      contratadoCents: 1_500_000,
      pagoCents: 700_000,
      entradasCents: 1_000_000,
      saldoCents: 300_000,
      aPagarCents: 800_000,
      disponivelOrcamentoCents: 500_000,
      progressoPercent: 63,
      compromissosAtrasados: 1,
      etapasAtrasadas: 0,
    });
  });

  it('ignora etapas, compromissos e entradas cancelados', () => {
    const summary = buildConstructionSummary({
      now,
      stages: [{ id: 's1', budgetCents: 100_000, status: 'cancelada' }],
      commitments: [{ id: 'c1', amountCents: 100_000, status: 'cancelada' }],
      payments: [],
      entries: [{ id: 'e1', amountCents: 100_000, occurredAt: now, status: 'cancelada' }],
    });
    expect(summary.previstoCents).toBe(0);
    expect(summary.contratadoCents).toBe(0);
    expect(summary.entradasCents).toBe(0);
  });

  it('detecta excesso de pagamento e de estorno', () => {
    const payments = [
      { id: 'p1', amountCents: 700_000, paidAt: now },
      { id: 'p2', amountCents: 300_000, paidAt: now, reversals: [{ amountCents: 100_000, occurredAt: now }] },
    ];
    expect(paymentExceedsCommitment({
      commitmentAmountCents: 1_200_000,
      currentPayments: payments,
      newPaymentCents: 300_000,
    })).toBe(false);
    expect(paymentExceedsCommitment({
      commitmentAmountCents: 1_200_000,
      currentPayments: payments,
      newPaymentCents: 301_000,
    })).toBe(true);
    expect(reversalExceedsPayment({ payment: payments[1], newReversalCents: 200_000 })).toBe(false);
    expect(reversalExceedsPayment({ payment: payments[1], newReversalCents: 200_001 })).toBe(true);
  });

  it('monta conta corrente com saldo anterior, filtro e ordem decrescente', () => {
    const ledger = buildLedger([
      { id: '1', type: 'entrada', occurredAt: '2026-07-01', description: 'Aporte', amountCents: 1_000_000 },
      { id: '2', type: 'pagamento', occurredAt: '2026-08-02', description: 'Elétrica', amountCents: 300_000 },
      { id: '3', type: 'estorno', occurredAt: '2026-08-03', description: 'Estorno', amountCents: 50_000 },
    ], new Date('2026-08-01'), new Date('2026-08-31'));

    expect(ledger.openingBalanceCents).toBe(1_000_000);
    expect(ledger.closingBalanceCents).toBe(750_000);
    expect(ledger.rows.map((row) => [row.id, row.balanceCents])).toEqual([
      ['3', 750_000],
      ['2', 700_000],
    ]);
  });
});
