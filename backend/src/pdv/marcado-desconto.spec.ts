/**
 * PEÇA MARCADA COM DESCONTO — o desconto tem que voltar VISÍVEL e não pode
 * ser concedido duas vezes (bug relatado pelo dono em 31/08).
 *
 * Antes: `puxarParaVenda` usava o VALORTOTAL (líquido) como preço unitário e
 * gravava `desconto: 0`. A peça de R$ 80 marcada por R$ 40 voltava como se
 * R$ 40 fosse o preço de tabela — sem riscado na tela e, pior, elegível a
 * levar os 50% da campanha DE NOVO no recálculo automático (R$ 20).
 *
 * Estes testes fixam as duas metades da correção:
 *   1. a aritmética que reconstitui bruto + desconto na volta do marcado;
 *   2. a trava do recálculo automático (`isManual`).
 */

/** Espelha marcados.service.ts (puxarParaVenda) — reconstituição do preço. */
function reconstituirItemMarcado(row: { VALOR: number; VALORTOTAL: number; QUANTIDADE?: number }) {
  const qty = Math.max(1, Number(row.QUANTIDADE) || 1);
  const valorTotal = Number(row.VALORTOTAL) || (Number(row.VALOR) || 0) * qty;
  const brutoUnit = Math.round((Number(row.VALOR) || 0) * 100) / 100;
  const liquidoUnit = qty > 0 ? Math.round((valorTotal / qty) * 100) / 100 : brutoUnit;
  const temBruto = brutoUnit > 0 && brutoUnit * qty >= valorTotal - 0.01;
  const precoUnit = temBruto ? brutoUnit : liquidoUnit;
  const desconto = temBruto
    ? Math.max(0, Math.round((brutoUnit * qty - valorTotal) * 100) / 100)
    : 0;
  return {
    precoUnit,
    desconto,
    total: Math.round((precoUnit * qty - desconto) * 100) / 100,
    promoTag: 'MARCADO',
    precoDeCents: desconto > 0 ? Math.round(brutoUnit * 100) : null,
  };
}

/** Espelha pdv.service.ts (applyAutoDiscounts) — quem a campanha NÃO toca. */
const isManual = (it: any) =>
  it.promoTag === 'MANUAL' ||
  it.promoTag === 'SEM_PROMO' ||
  (it.promoTag === 'MARCADO' && Number(it.desconto) > 0);

describe('marcado com desconto — volta visível e sem desconto em dobro', () => {
  it('peça de R$ 80 marcada por R$ 40 volta com preço cheio e desconto explícito', () => {
    const item = reconstituirItemMarcado({ VALOR: 80, VALORTOTAL: 40, QUANTIDADE: 1 });
    expect(item.precoUnit).toBe(80); // preço de tabela de volta na linha
    expect(item.desconto).toBe(40); // o que a cliente já ganhou, explícito
    expect(item.total).toBe(40); // ela paga o combinado — nada muda no caixa
    expect(item.precoDeCents).toBe(8000); // ancora o riscado "de R$ 80,00"
  });

  it('o total cobrado é o mesmo de antes da correção (a cliente não paga a mais)', () => {
    const antes = 40; // comportamento antigo: precoUnit 40, desconto 0
    const item = reconstituirItemMarcado({ VALOR: 80, VALORTOTAL: 40, QUANTIDADE: 1 });
    expect(item.total).toBe(antes);
  });

  it('quantidade > 1 divide certo e mantém o desconto do lote', () => {
    const item = reconstituirItemMarcado({ VALOR: 100, VALORTOTAL: 150, QUANTIDADE: 2 });
    expect(item.precoUnit).toBe(100);
    expect(item.desconto).toBe(50); // 200 de bruto − 150 combinados
    expect(item.total).toBe(150);
  });

  it('marcado SEM desconto volta limpo — sem desconto inventado', () => {
    const item = reconstituirItemMarcado({ VALOR: 89.9, VALORTOTAL: 89.9, QUANTIDADE: 1 });
    expect(item.precoUnit).toBe(89.9);
    expect(item.desconto).toBe(0);
    expect(item.precoDeCents).toBeNull();
  });

  it('marcado antigo/do Giga sem VALOR cai no comportamento de antes (não quebra)', () => {
    const item = reconstituirItemMarcado({ VALOR: 0, VALORTOTAL: 45, QUANTIDADE: 1 });
    expect(item.precoUnit).toBe(45);
    expect(item.desconto).toBe(0);
  });

  it('VALORTOTAL maior que o bruto (dado torto) não vira desconto negativo', () => {
    const item = reconstituirItemMarcado({ VALOR: 50, VALORTOTAL: 70, QUANTIDADE: 1 });
    expect(item.desconto).toBe(0);
    expect(item.precoUnit).toBe(70); // não confia no bruto incoerente
  });

  it('a campanha NÃO toca em marcado que já veio com desconto', () => {
    expect(isManual({ promoTag: 'MARCADO', desconto: 40 })).toBe(true);
  });

  it('marcado a preço cheio continua elegível à campanha do dia do fechamento', () => {
    expect(isManual({ promoTag: 'MARCADO', desconto: 0 })).toBe(false);
  });

  it('as travas antigas seguem valendo', () => {
    expect(isManual({ promoTag: 'MANUAL', desconto: 8 })).toBe(true);
    expect(isManual({ promoTag: 'SEM_PROMO', desconto: 0 })).toBe(true);
    expect(isManual({ promoTag: 'PROMO 50% · 2023', desconto: 40 })).toBe(false);
  });

  it('o cenário do prejuízo: 50% em cima de 50% não acontece mais', () => {
    // R$ 80 marcada por R$ 40 (promo do dia da marcação)
    const item = reconstituirItemMarcado({ VALOR: 80, VALORTOTAL: 40, QUANTIDADE: 1 });
    // Campanha ativa no dia do fechamento tentaria aplicar 50%:
    const campanhaAplicaria = !isManual(item);
    expect(campanhaAplicaria).toBe(false);
    // Se tivesse aplicado, a peça sairia por R$ 20 — metade do combinado.
    const seTivesseAplicado = Math.round(item.precoUnit * 0.5 * 100) / 100;
    expect(seTivesseAplicado).toBe(40);
    expect(item.total).toBe(40); // segue nos R$ 40 combinados
  });
});
