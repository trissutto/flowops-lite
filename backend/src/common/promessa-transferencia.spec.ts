import { promessaOrfaDeTransferencia } from './promessa-transferencia';

/**
 * O caso de 23/11/2026: a linha TRANSFERENCIA que o bipe gravou e não amarrou
 * na caixa. Só ELA é órfã — tudo que tem caixa, ou que é ordem da matriz
 * (REALINHAMENTO), continua sendo promessa.
 */
describe('promessaOrfaDeTransferencia', () => {
  it('TRANSFERENCIA pendente sem caixa → órfã (o bipe que não completou)', () => {
    expect(
      promessaOrfaDeTransferencia({ tipo: 'TRANSFERENCIA', realignmentStatus: 'pending', shipmentId: null }),
    ).toBe(true);
  });

  it('TRANSFERENCIA dentro da caixa (sent + shipmentId) → promessa de verdade', () => {
    expect(
      promessaOrfaDeTransferencia({ tipo: 'TRANSFERENCIA', realignmentStatus: 'sent', shipmentId: 'rem-1' }),
    ).toBe(false);
  });

  it('TRANSFERENCIA pendente MAS com caixa → não é órfã (a caixa decide)', () => {
    expect(
      promessaOrfaDeTransferencia({ tipo: 'TRANSFERENCIA', realignmentStatus: 'pending', shipmentId: 'rem-1' }),
    ).toBe(false);
  });

  it('REALINHAMENTO pendente sem caixa é a pilha da loja — promessa, nunca órfã', () => {
    expect(
      promessaOrfaDeTransferencia({ tipo: 'REALINHAMENTO', realignmentStatus: 'pending', shipmentId: null }),
    ).toBe(false);
  });

  it('cancelada/recebida nunca é órfã (nem entra na conta)', () => {
    expect(
      promessaOrfaDeTransferencia({ tipo: 'TRANSFERENCIA', realignmentStatus: 'cancelled', shipmentId: null }),
    ).toBe(false);
    expect(
      promessaOrfaDeTransferencia({ tipo: 'TRANSFERENCIA', realignmentStatus: 'received', shipmentId: null }),
    ).toBe(false);
  });

  it('tipo casa sem se importar com caixa/espaço; tipo ausente não é transferência', () => {
    expect(
      promessaOrfaDeTransferencia({ tipo: ' transferencia ', realignmentStatus: 'pending', shipmentId: '' }),
    ).toBe(true);
    expect(promessaOrfaDeTransferencia({ realignmentStatus: 'pending', shipmentId: null })).toBe(false);
  });
});
