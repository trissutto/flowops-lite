export type ConstructionCommitmentValue = {
  id: string;
  amountCents: number;
  dueDate?: Date | string | null;
  status?: string | null;
};

export type ConstructionPaymentValue = {
  id: string;
  amountCents: number;
  paidAt: Date | string;
  commitmentId?: string | null;
  status?: string | null;
  reversals?: Array<{
    id?: string;
    amountCents: number;
    occurredAt: Date | string;
  }>;
};

export type ConstructionEntryValue = {
  id: string;
  amountCents: number;
  occurredAt: Date | string;
  status?: string | null;
  type?: string | null;
};

export type ConstructionStageValue = {
  id: string;
  budgetCents: number;
  progressPercent?: number | null;
  plannedEndAt?: Date | string | null;
  status?: string | null;
};

export function netPaymentCents(payment: ConstructionPaymentValue): number {
  if (payment.status === 'estornado') return 0;
  const reversed = (payment.reversals || []).reduce(
    (sum, reversal) => sum + nonNegativeInt(reversal.amountCents),
    0,
  );
  return Math.max(0, nonNegativeInt(payment.amountCents) - reversed);
}

export function buildConstructionSummary(input: {
  stages: ConstructionStageValue[];
  commitments: ConstructionCommitmentValue[];
  payments: ConstructionPaymentValue[];
  entries: ConstructionEntryValue[];
  now?: Date;
}) {
  const now = input.now || new Date();
  const activeStages = input.stages.filter((item) => item.status !== 'cancelada');
  const activeCommitments = input.commitments.filter((item) => item.status !== 'cancelada');
  const activeEntries = input.entries.filter((item) => item.status !== 'cancelada');
  const activePayments = input.payments.filter((item) => item.status !== 'estornado');

  const previstoCents = sum(activeStages.map((item) => item.budgetCents));
  const contratadoCents = sum(activeCommitments.map((item) => item.amountCents));
  const pagoCents = sum(activePayments.map(netPaymentCents));
  const entradasCents = sum(activeEntries.map((item) => item.amountCents));

  const paidByCommitment = new Map<string, number>();
  for (const payment of activePayments) {
    if (!payment.commitmentId) continue;
    paidByCommitment.set(
      payment.commitmentId,
      (paidByCommitment.get(payment.commitmentId) || 0) + netPaymentCents(payment),
    );
  }

  let aPagarCents = 0;
  let compromissosAtrasados = 0;
  for (const commitment of activeCommitments) {
    const pending = Math.max(
      0,
      nonNegativeInt(commitment.amountCents) - (paidByCommitment.get(commitment.id) || 0),
    );
    aPagarCents += pending;
    if (pending > 0 && commitment.dueDate && endOfDay(commitment.dueDate) < now) {
      compromissosAtrasados += 1;
    }
  }

  const weightedBudget = sum(activeStages.map((item) => item.budgetCents));
  const progressoPercent = activeStages.length === 0
    ? 0
    : weightedBudget > 0
      ? Math.round(
          activeStages.reduce(
            (total, stage) => total + nonNegativeInt(stage.budgetCents) * clampPercent(stage.progressPercent),
            0,
          ) / weightedBudget,
        )
      : Math.round(
          activeStages.reduce((total, stage) => total + clampPercent(stage.progressPercent), 0)
          / activeStages.length,
        );

  const etapasAtrasadas = activeStages.filter((stage) =>
    stage.status !== 'concluida'
      && stage.plannedEndAt
      && clampPercent(stage.progressPercent) < 100
      && endOfDay(stage.plannedEndAt) < now,
  ).length;

  return {
    previstoCents,
    contratadoCents,
    pagoCents,
    entradasCents,
    saldoCents: entradasCents - pagoCents,
    aPagarCents,
    disponivelOrcamentoCents: previstoCents - contratadoCents,
    progressoPercent,
    compromissosAtrasados,
    etapasAtrasadas,
  };
}

export function paymentExceedsCommitment(input: {
  commitmentAmountCents: number;
  currentPayments: ConstructionPaymentValue[];
  newPaymentCents: number;
}) {
  const alreadyPaid = sum(input.currentPayments.map(netPaymentCents));
  return alreadyPaid + nonNegativeInt(input.newPaymentCents) > nonNegativeInt(input.commitmentAmountCents);
}

export function reversalExceedsPayment(input: {
  payment: ConstructionPaymentValue;
  newReversalCents: number;
}) {
  const reversed = sum((input.payment.reversals || []).map((item) => item.amountCents));
  return reversed + nonNegativeInt(input.newReversalCents) > nonNegativeInt(input.payment.amountCents);
}

export type LedgerRow = {
  id: string;
  type: 'entrada' | 'pagamento' | 'estorno';
  occurredAt: Date | string;
  description: string;
  amountCents: number;
  source?: any;
  balanceCents?: number;
};

export function buildLedger(rows: LedgerRow[], from?: Date | null, to?: Date | null) {
  const sorted = [...rows].sort((a, b) => {
    const dateDiff = asDate(a.occurredAt).getTime() - asDate(b.occurredAt).getTime();
    return dateDiff || a.id.localeCompare(b.id);
  });

  let balanceCents = 0;
  let openingBalanceCents = 0;
  const result: LedgerRow[] = [];
  for (const row of sorted) {
    const occurredAt = asDate(row.occurredAt);
    const signed = row.type === 'pagamento'
      ? -nonNegativeInt(row.amountCents)
      : nonNegativeInt(row.amountCents);
    balanceCents += signed;
    if (from && occurredAt < startOfDay(from)) {
      openingBalanceCents = balanceCents;
      continue;
    }
    if (to && occurredAt > endOfDay(to)) continue;
    result.push({ ...row, amountCents: nonNegativeInt(row.amountCents), balanceCents });
  }

  return {
    openingBalanceCents,
    closingBalanceCents: result.length ? result[result.length - 1].balanceCents || 0 : openingBalanceCents,
    rows: result.reverse(),
  };
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + nonNegativeInt(value), 0);
}

function nonNegativeInt(value: number | null | undefined) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function clampPercent(value: number | null | undefined) {
  return Math.min(100, nonNegativeInt(value));
}

function asDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function startOfDay(value: Date | string) {
  const date = asDate(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(value: Date | string) {
  const date = asDate(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}
