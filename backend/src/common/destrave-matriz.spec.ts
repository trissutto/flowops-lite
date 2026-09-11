/**
 * A CHAVE DA MATRIZ (10/09/2026, LP-001312) — trava não pode ser beco sem
 * saída, mas a chave também não pode ser botão anônimo.
 */
import {
  MOTIVO_MINIMO,
  motivoDeRecusaDoDestrave,
  notaDoDestrave,
  podeDestravar,
} from './destrave-matriz';

describe('podeDestravar — a chave é da matriz', () => {
  it.each(['admin', 'operator', 'ADMIN', ' Operator '])('%s destrava', (role) => {
    expect(podeDestravar(role)).toBe(true);
  });

  it.each(['store', 'vendedora', '', null, undefined])('%s NÃO destrava', (role) => {
    expect(podeDestravar(role as any)).toBe(false);
  });
});

describe('motivoDeRecusaDoDestrave — o "não" diz o que falta', () => {
  it('vendedora não destrava, e a mensagem manda pedir pra matriz', () => {
    const r = motivoDeRecusaDoDestrave({ role: 'store', motivo: 'cliente pediu outro tamanho' });
    expect(r).toMatch(/matriz/i);
  });

  it('matriz sem motivo escrito não destrava', () => {
    expect(motivoDeRecusaDoDestrave({ role: 'admin', motivo: '' })).toMatch(/motivo/i);
    expect(motivoDeRecusaDoDestrave({ role: 'admin', motivo: '  ok ' })).toMatch(/motivo/i);
    expect(motivoDeRecusaDoDestrave({ role: 'admin' })).toMatch(/motivo/i);
  });

  it('matriz com motivo escrito destrava', () => {
    expect(
      motivoDeRecusaDoDestrave({ role: 'admin', motivo: 'cliente pediu tamanho 48, peça ainda na loja' }),
    ).toBeNull();
  });

  it('o mínimo é curto de propósito — trava não pode virar redação', () => {
    expect(MOTIVO_MINIMO).toBeLessThanOrEqual(10);
    expect(motivoDeRecusaDoDestrave({ role: 'operator', motivo: 'troca' })).toBeNull();
  });
});

describe('notaDoDestrave — o histórico guarda a trava E o porquê', () => {
  it('carrega quem, o que travava e o motivo', () => {
    const nota = notaDoDestrave(
      'SOROCABA já postou esta peça',
      'rastreio saiu por engano, peça na arara',
      'Thiago',
    );
    expect(nota).toContain('Thiago');
    expect(nota).toContain('SOROCABA já postou esta peça');
    expect(nota).toContain('rastreio saiu por engano');
    expect(nota).toContain('🔓');
  });

  it('sem ator não quebra a frase', () => {
    expect(notaDoDestrave('trava', 'motivo')).not.toContain('()');
  });
});
