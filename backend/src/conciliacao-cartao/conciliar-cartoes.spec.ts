import {
  conciliarCartoes,
  familiaBandeira,
  frasesDaConciliacao,
  PagamentoSistema,
  TransacaoMaquininha,
} from './conciliar-cartoes';

/**
 * A régua da conferência de cartões (16/09/2026): vendas no cartão do PDV ×
 * transações da maquininha Stone. O spec tranca que o checklist só acuse
 * pendência de verdade — alarme falso mata a conferência.
 */

let seq = 0;
const em = (hhmm: string) => new Date(`2026-09-15T${hhmm}:00-03:00`);

const venda = (valor: number, hora: string, over: Partial<PagamentoSistema> = {}): PagamentoSistema => ({
  id: `p${++seq}`,
  vendaId: `v${seq}`,
  venda: `0000000${seq}`.slice(-8),
  valor,
  tipo: 'credito',
  bandeira: 'MASTERCARD',
  parcelas: 1,
  momento: em(hora),
  vendaCancelada: false,
  vendedora: 'MARIA',
  cliente: null,
  ...over,
});

const stone = (valor: number, hora: string, over: Partial<TransacaoMaquininha> = {}): TransacaoMaquininha => ({
  id: `t${++seq}`,
  nsu: `2615${seq}`,
  valorCapturado: valor,
  valorCancelado: 0,
  tipo: 'credito',
  bandeira: 'MASTERCARD',
  parcelas: 1,
  momento: em(hora),
  finalCartao: '1234',
  autorizacao: 'A1B2C3',
  terminal: 'POS',
  ...over,
});

const linhaDe = (r: ReturnType<typeof conciliarCartoes>, pagamentoId: string) =>
  r.linhas.find((l) => l.pagamentoId === pagamentoId);

describe('conciliação de cartões — pares', () => {
  it('venda e transação de mesmo valor e horário conferem', () => {
    const p = venda(149.9, '14:32');
    const t = stone(149.9, '14:31');
    const r = conciliarCartoes([p], [t]);
    expect(r.status).toBe('confere');
    expect(linhaDe(r, p.id)).toMatchObject({ situacao: 'confere', transacaoId: t.id, diferenca: 0 });
    expect(r.totais).toEqual({ sistema: { qtd: 1, valor: 149.9 }, maquininha: { qtd: 1, valor: 149.9 }, valorDivergente: 0 });
  });

  it('duas vendas de mesmo valor: cada uma com a transação do horário dela', () => {
    const cedo = venda(80, '10:05');
    const tarde = venda(80, '16:40');
    const tTarde = stone(80, '16:39');
    const tCedo = stone(80, '10:04');
    const r = conciliarCartoes([cedo, tarde], [tTarde, tCedo]);
    expect(linhaDe(r, cedo.id)?.transacaoId).toBe(tCedo.id);
    expect(linhaDe(r, tarde.id)?.transacaoId).toBe(tTarde.id);
    expect(r.status).toBe('confere');
  });

  it('crédito × débito trocado casa, mas vira atenção', () => {
    const p = venda(99, '09:30', { tipo: 'debito', bandeira: 'REDESHOP' });
    const t = stone(99, '09:31', { tipo: 'credito', bandeira: 'MASTERCARD' });
    const r = conciliarCartoes([p], [t]);
    expect(r.status).toBe('atencao');
    expect(linhaDe(r, p.id)?.situacao).toBe('confere_com_nota');
    expect(linhaDe(r, p.id)?.notas.join(' ')).toContain('DÉBITO');
  });

  it('parcelas diferentes viram atenção', () => {
    const p = venda(300, '11:00', { parcelas: 3 });
    const t = stone(300, '11:01', { parcelas: 2 });
    expect(linhaDe(conciliarCartoes([p], [t]), p.id)?.notas.join(' ')).toContain('parcelas: sistema 3x');
  });

  it('bandeira da lista antiga do PDV ajuda a desempatar, sem virar alarme', () => {
    const visa = venda(50, '10:00', { bandeira: 'VISANET' });
    const master = venda(50, '10:00', { bandeira: 'REDESHOP', tipo: 'debito' });
    const tMaster = stone(50, '10:00', { bandeira: 'MASTERCARD', tipo: 'debito' });
    const tVisa = stone(50, '10:00', { bandeira: 'VISA' });
    const r = conciliarCartoes([visa, master], [tMaster, tVisa]);
    expect(linhaDe(r, visa.id)?.transacaoId).toBe(tVisa.id);
    expect(linhaDe(r, master.id)?.transacaoId).toBe(tMaster.id);
    expect(r.status).toBe('confere');
  });
});

describe('conciliação de cartões — divergências', () => {
  it('venda no cartão sem transação na Stone', () => {
    const p = venda(59.9, '12:00', { tipo: 'debito' });
    const r = conciliarCartoes([p], []);
    expect(r.status).toBe('divergente');
    expect(linhaDe(r, p.id)).toMatchObject({ situacao: 'sem_transacao', diferenca: 59.9 });
    expect(r.contagem.semTransacao).toBe(1);
  });

  it('transação na Stone sem venda no sistema', () => {
    const t = stone(210, '15:00');
    const r = conciliarCartoes([], [t]);
    expect(r.status).toBe('divergente');
    expect(r.linhas[0]).toMatchObject({ situacao: 'sem_venda', transacaoId: t.id, diferenca: -210 });
    expect(r.linhas[0].notas[0]).toContain('dinheiro/PIX');
  });

  it('mesmo horário e valor diferente é UM alarme, não dois', () => {
    const p = venda(100, '14:30');
    const t = stone(10, '14:31');
    const r = conciliarCartoes([p], [t]);
    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0]).toMatchObject({ situacao: 'valor_diferente', valorSistema: 100, valorMaquininha: 10, diferenca: 90 });
  });

  it('venda ativa com a transação cancelada na maquininha', () => {
    const p = venda(120, '13:00');
    const t = stone(120, '13:01', { valorCancelado: 120 });
    const r = conciliarCartoes([p], [t]);
    expect(linhaDe(r, p.id)).toMatchObject({ situacao: 'estornada_na_maquininha', diferenca: 120 });
    expect(r.status).toBe('divergente');
  });

  it('venda estornada no sistema com a transação ainda valendo', () => {
    const p = venda(120, '13:00', { vendaCancelada: true });
    const t = stone(120, '13:01');
    const r = conciliarCartoes([p], [t]);
    expect(linhaDe(r, p.id)).toMatchObject({ situacao: 'estornada_so_no_sistema', diferenca: -120 });
  });

  it('cancelamento parcial na maquininha aparece como valor diferente', () => {
    const p = venda(200, '16:00');
    const t = stone(200, '16:01', { valorCancelado: 50 });
    const l = linhaDe(conciliarCartoes([p], [t]), p.id);
    expect(l).toMatchObject({ situacao: 'valor_diferente', valorMaquininha: 150, diferenca: 50 });
    expect(l?.notas[0]).toContain('cancelamento parcial');
  });

  it('as divergências vêm primeiro e somam o valor em jogo', () => {
    const r = conciliarCartoes([venda(10, '10:00'), venda(20, '11:00')], [stone(10, '10:00'), stone(35, '18:00')]);
    expect(r.linhas.map((l) => l.situacao)).toEqual(['sem_transacao', 'sem_venda', 'confere']);
    expect(r.totais.valorDivergente).toBe(55);
  });
});

describe('conciliação de cartões — o que não pesa', () => {
  it('estornada nos dois lados é neutra', () => {
    const p = venda(80, '10:00', { vendaCancelada: true });
    const t = stone(80, '10:00', { valorCancelado: 80 });
    const r = conciliarCartoes([p], [t]);
    expect(linhaDe(r, p.id)?.situacao).toBe('estornada_nos_dois');
    expect(r.status).toBe('confere');
  });

  it('passada e cancelada na maquininha sem venda no sistema é neutra', () => {
    const r = conciliarCartoes([], [stone(45, '10:00', { valorCancelado: 45 })]);
    expect(r.linhas[0].situacao).toBe('cancelada_na_maquininha');
    expect(r.status).toBe('confere');
    expect(r.totais.maquininha).toEqual({ qtd: 0, valor: 0 });
  });

  it('venda estornada sem transação não acusa nada', () => {
    const r = conciliarCartoes([venda(45, '10:00', { vendaCancelada: true })], []);
    expect(r.linhas).toHaveLength(0);
    expect(r.status).toBe('sem_movimento');
  });

  it('link pago na maquininha casa, e a falta dele não é alarme', () => {
    const link = venda(70, '12:00', { obrigatorio: false });
    const outro = venda(90, '15:00', { obrigatorio: false });
    const r = conciliarCartoes([link, outro], [stone(70, '12:05')]);
    expect(linhaDe(r, link.id)?.situacao).toBe('confere');
    expect(linhaDe(r, outro.id)).toBeUndefined();
    expect(r.status).toBe('confere');
  });

  it('dia sem nada é "sem movimento"', () => {
    expect(conciliarCartoes([], []).status).toBe('sem_movimento');
  });
});

describe('conciliação de cartões — textos', () => {
  it('família da bandeira', () => {
    expect(familiaBandeira('VISANET')).toBe('VISA');
    expect(familiaBandeira('VISA ELECTRON')).toBe('VISA');
    expect(familiaBandeira('REDESHOP')).toBe('MASTER');
    expect(familiaBandeira('MASTERCARD')).toBe('MASTER');
    expect(familiaBandeira('elo')).toBe('ELO');
    expect(familiaBandeira(null)).toBeNull();
  });

  it('frases do checklist', () => {
    const r = conciliarCartoes(
      [venda(100, '10:00'), venda(89.8, '11:00'), venda(55, '12:00', { tipo: 'debito' })],
      [stone(210, '18:00'), stone(55, '12:01')],
    );
    expect(frasesDaConciliacao(r)).toEqual([
      '2 vendas no cartão sem transação na Stone (R$ 189,80)',
      '1 transação na Stone sem venda no sistema (R$ 210,00)',
      '1 venda com crédito×débito ou parcelas trocados',
    ]);
  });
});
