import {
  cruzar,
  Esperado,
  normalizarBandeira,
  normalizarForma,
  normalizarNumero,
  TicketEntrada,
} from './cruzamento';

/**
 * A régua da conferência de tickets (16/09/2026): o que o Flow gravou × o que
 * a IA leu nas fotos. O que este arquivo tranca é que o checklist só acuse o
 * que é pendência de verdade — alarme falso mata a conferência inteira.
 */

const DIA = '2026-09-15';
let seq = 0;

const cartao = (valor: number, hora: string, over: Partial<Esperado> = {}): Esperado => ({
  chave: `cartao:p${++seq}`,
  tipo: 'cartao',
  obrigatorio: true,
  valor,
  minuto: min(hora),
  operacao: 'credito',
  bandeira: 'MASTERCARD',
  parcelas: 1,
  titulo: `Venda ${seq}`,
  ...over,
});

const cupom = (numero: string, valor: number, formas: string[], over: Partial<Esperado> = {}): Esperado => ({
  chave: `cupom:s${++seq}`,
  tipo: 'cupom',
  obrigatorio: true,
  valor,
  minuto: min('10:00'),
  numero,
  formas,
  titulo: `Venda #${numero.toUpperCase()}`,
  ...over,
});

const crediario = (numero: string, valor: number, formas: string[], over: Partial<Esperado> = {}): Esperado => ({
  chave: `crediario:b${++seq}`,
  tipo: 'crediario',
  obrigatorio: true,
  valor,
  minuto: min('11:00'),
  numero,
  formas,
  cliente: 'MARIA APARECIDA SILVA',
  titulo: `Baixa #${numero.toUpperCase()}`,
  ...over,
});

const ticket = (over: Partial<TicketEntrada>): TicketEntrada => ({
  id: `t${++seq}`,
  fotoId: 'f1',
  origem: 'maquininha',
  operacao: 'credito',
  valor: 100,
  data: DIA,
  hora: '10:00',
  nsu: null,
  bandeira: 'MASTERCARD',
  parcelas: 1,
  numero: null,
  formas: [],
  cliente: null,
  legivel: true,
  confianca: 'alta',
  ...over,
});

function min(h: string): number {
  const [a, b] = h.split(':').map(Number);
  return a * 60 + b;
}

const linhaDo = (r: ReturnType<typeof cruzar>, chave: string) => r.linhas.find((l) => l.esperado === chave);

describe('conferência de tickets — cartão', () => {
  it('venda no cartão com o ticket da maquininha confere', () => {
    const e = cartao(149.9, '14:32');
    const t = ticket({ valor: 149.9, hora: '14:33' });
    const r = cruzar([e], [t], DIA);
    expect(r.status).toBe('confere');
    expect(linhaDo(r, e.chave)).toMatchObject({ situacao: 'confere', ticketId: t.id });
    expect(r.totais.cartao).toMatchObject({ sistema: 149.9, tickets: 149.9, esperados: 1, comTicket: 1 });
  });

  it('duas vendas de mesmo valor: cada ticket vai pra venda do horário mais perto', () => {
    const cedo = cartao(80, '10:05');
    const tarde = cartao(80, '16:40');
    const tTarde = ticket({ valor: 80, hora: '16:41' });
    const tCedo = ticket({ valor: 80, hora: '10:06' });
    const r = cruzar([cedo, tarde], [tTarde, tCedo], DIA);
    expect(linhaDo(r, cedo.chave)?.ticketId).toBe(tCedo.id);
    expect(linhaDo(r, tarde.chave)?.ticketId).toBe(tTarde.id);
    expect(r.status).toBe('confere');
  });

  it('venda no cartão sem ticket é divergência', () => {
    const e = cartao(59.9, '12:00', { operacao: 'debito' });
    const r = cruzar([e], [], DIA);
    expect(r.status).toBe('divergente');
    expect(linhaDo(r, e.chave)?.situacao).toBe('sem_ticket');
    expect(linhaDo(r, e.chave)?.notas[0]).toContain('débito');
    expect(r.contagem.semTicket).toBe(1);
  });

  it('ticket da maquininha sem venda no sistema é divergência', () => {
    const t = ticket({ valor: 210, hora: '15:00' });
    const r = cruzar([], [t], DIA);
    expect(r.status).toBe('divergente');
    expect(r.linhas[0]).toMatchObject({ situacao: 'sem_registro', ticketId: t.id, grupo: 'cartao' });
  });

  it('crédito × débito trocado casa, mas vira atenção', () => {
    const e = cartao(99, '09:30', { operacao: 'debito' });
    const t = ticket({ valor: 99, hora: '09:30', operacao: 'credito' });
    const r = cruzar([e], [t], DIA);
    expect(r.status).toBe('atencao');
    expect(linhaDo(r, e.chave)?.situacao).toBe('confere_com_nota');
    expect(linhaDo(r, e.chave)?.notas.join(' ')).toContain('DÉBITO');
  });

  it('mesmo horário e valor diferente é valor diferente (não dois alarmes soltos)', () => {
    const e = cartao(100, '14:30');
    const t = ticket({ valor: 10, hora: '14:31' });
    const r = cruzar([e], [t], DIA);
    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0]).toMatchObject({ situacao: 'valor_diferente', valorSistema: 100, valorTicket: 10 });
  });

  it('bandeira da lista antiga do PDV casa com a impressa na maquininha', () => {
    const visa = cartao(50, '10:00', { bandeira: 'VISANET' });
    const master = cartao(50, '10:00', { bandeira: 'REDESHOP', operacao: 'debito' });
    const tMaster = ticket({ valor: 50, hora: '10:00', bandeira: 'MAESTRO', operacao: 'debito' });
    const tVisa = ticket({ valor: 50, hora: '10:00', bandeira: 'VISA' });
    const r = cruzar([visa, master], [tMaster, tVisa], DIA);
    expect(linhaDo(r, visa.chave)?.ticketId).toBe(tVisa.id);
    expect(linhaDo(r, master.chave)?.ticketId).toBe(tMaster.id);
  });

  it('venda estornada aceita o ticket, mas avisa', () => {
    const e = cartao(120, '13:00', { obrigatorio: false, cancelada: true });
    const t = ticket({ valor: 120, hora: '13:01' });
    const r = cruzar([e], [t], DIA);
    expect(linhaDo(r, e.chave)?.situacao).toBe('confere_com_nota');
    expect(linhaDo(r, e.chave)?.notas.join(' ')).toContain('ESTORNADA');
  });

  it('venda estornada sem ticket não acusa nada', () => {
    const e = cartao(120, '13:00', { obrigatorio: false, cancelada: true });
    const r = cruzar([e], [], DIA);
    expect(r.linhas).toHaveLength(0);
    expect(r.status).toBe('sem_movimento');
  });
});

describe('conferência de tickets — cupom das vendas em dinheiro/PIX', () => {
  it('casa pelo número impresso mesmo com o valor errado — e acusa o valor', () => {
    const e = cupom('1a2b3c4d', 89.9, ['dinheiro']);
    const t = ticket({ origem: 'cupom_venda', operacao: 'dinheiro', valor: 98.9, numero: 'Venda #1A2B3C4D', formas: ['DINHEIRO'] });
    const r = cruzar([e], [t], DIA);
    expect(linhaDo(r, e.chave)).toMatchObject({ situacao: 'valor_diferente', ticketId: t.id });
  });

  it('cupom que diz DINHEIRO numa venda que hoje é PIX é forma diferente', () => {
    const e = cupom('aa11bb22', 150, ['pix']);
    const t = ticket({ origem: 'cupom_venda', operacao: 'dinheiro', valor: 150, numero: '#AA11BB22', formas: ['DINHEIRO'] });
    const r = cruzar([e], [t], DIA);
    expect(linhaDo(r, e.chave)?.situacao).toBe('forma_diferente');
    expect(r.status).toBe('divergente');
  });

  it('as 2 vias do mesmo cupom contam uma vez só', () => {
    const e = cupom('cafe0001', 40, ['dinheiro']);
    const via1 = ticket({ origem: 'cupom_venda', operacao: 'dinheiro', valor: 40, numero: 'Venda #CAFE0001', formas: ['DINHEIRO'] });
    const via2 = ticket({ origem: 'cupom_venda', operacao: 'dinheiro', valor: 40, numero: 'Venda #CAFE0001', formas: ['DINHEIRO'], fotoId: 'f2' });
    const r = cruzar([e], [via1, via2], DIA);
    expect(r.status).toBe('confere');
    expect(r.linhas.map((l) => l.situacao).sort()).toEqual(['confere', 'duplicado']);
    expect(r.totais.cupons.tickets).toBe(40);
  });

  it('venda no cartão não cobra cupom — mas aceita o que vier', () => {
    const semCupom = cupom('00000001', 70, ['credito'], { obrigatorio: false });
    const comCupom = cupom('00000002', 90, ['debito'], { obrigatorio: false });
    const t = ticket({ origem: 'cupom_venda', operacao: 'debito', valor: 90, numero: '#00000002', formas: ['CARTÃO DÉBITO'] });
    const r = cruzar([semCupom, comCupom], [t], DIA);
    expect(linhaDo(r, semCupom.chave)).toBeUndefined();
    expect(linhaDo(r, comCupom.chave)?.situacao).toBe('confere');
    expect(r.status).toBe('confere');
  });

  it('venda em dinheiro sem cupom é divergência', () => {
    const e = cupom('deadbeef', 35, ['dinheiro']);
    const r = cruzar([e], [], DIA);
    expect(linhaDo(r, e.chave)?.situacao).toBe('sem_ticket');
    expect(linhaDo(r, e.chave)?.notas[0]).toContain('dinheiro');
  });
});

describe('conferência de tickets — PIX e crediário', () => {
  it('PIX confirmado pelo banco não cobra comprovante; PIX externo cobra', () => {
    const gateway = { ...cartao(60, '10:00'), chave: 'pix:g', tipo: 'pix' as const, obrigatorio: false };
    const externo = { ...cartao(75, '11:00'), chave: 'pix:x', tipo: 'pix' as const, obrigatorio: true, pixExterno: true };
    const r = cruzar([gateway, externo], [], DIA);
    expect(linhaDo(r, 'pix:g')).toBeUndefined();
    expect(linhaDo(r, 'pix:x')?.situacao).toBe('sem_ticket');
  });

  it('comprovante de PIX casa com o PIX externo', () => {
    const externo = { ...cartao(75, '11:00'), chave: 'pix:x', tipo: 'pix' as const, obrigatorio: true, pixExterno: true };
    const t = ticket({ origem: 'comprovante_pix', operacao: 'pix', valor: 75, hora: '11:02', bandeira: null });
    const r = cruzar([externo], [t], DIA);
    expect(linhaDo(r, 'pix:x')?.situacao).toBe('confere');
    expect(linhaDo(r, 'pix:x')?.notas.join(' ')).toContain('comprovante');
    expect(r.status).toBe('confere');
    expect(r.totais.pix.tickets).toBe(75);
  });

  it('recibo de crediário casa pelo número da baixa, e misto = dinheiro + PIX', () => {
    const e = crediario('0f0e0d0c', 230.5, ['dinheiro', 'pix']);
    const t = ticket({
      origem: 'recibo_crediario',
      operacao: 'misto',
      valor: 230.5,
      numero: 'Baixa #0F0E0D0C',
      formas: ['MISTO'],
      cliente: 'Maria Aparecida',
    });
    const r = cruzar([e], [t], DIA);
    expect(linhaDo(r, e.chave)?.situacao).toBe('confere');
  });

  it('recibo sem número casa pelo valor e pela cliente', () => {
    const outra = crediario('11111111', 100, ['dinheiro'], { cliente: 'JOANA PEREIRA', minuto: min('11:00') });
    const maria = crediario('22222222', 100, ['dinheiro'], { minuto: min('11:00') });
    const t = ticket({ origem: 'recibo_crediario', operacao: 'dinheiro', valor: 100, hora: '11:00', formas: ['DINHEIRO'], cliente: 'MARIA A. SILVA' });
    const r = cruzar([outra, maria], [t], DIA);
    expect(linhaDo(r, maria.chave)?.ticketId).toBe(t.id);
    expect(linhaDo(r, outra.chave)?.situacao).toBe('sem_ticket');
  });
});

describe('conferência de tickets — papel que não entra na conta', () => {
  it('ticket ilegível vira atenção (tirar outra foto), não divergência', () => {
    const e = cartao(30, '10:00');
    const ok = ticket({ valor: 30, hora: '10:00' });
    const borrado = ticket({ valor: null, legivel: false });
    const r = cruzar([e], [ok, borrado], DIA);
    expect(r.status).toBe('atencao');
    expect(r.contagem.ilegiveis).toBe(1);
  });

  it('estorno na maquininha é atenção', () => {
    const r = cruzar([], [ticket({ operacao: 'estorno', valor: 45 })], DIA);
    expect(r.linhas[0]).toMatchObject({ situacao: 'estorno', grupo: 'outros' });
    expect(r.status).toBe('atencao');
  });

  it('ticket de outro dia sem par não acusa venda sumida', () => {
    const r = cruzar([], [ticket({ valor: 45, data: '2026-09-12' })], DIA);
    expect(r.linhas[0].situacao).toBe('fora_do_dia');
    expect(r.status).toBe('atencao');
  });

  it('sem nada esperado e sem papel é "sem movimento"', () => {
    expect(cruzar([], [], DIA).status).toBe('sem_movimento');
  });

  it('a lista sai com as divergências primeiro', () => {
    const r = cruzar([cartao(10, '10:00'), cartao(20, '11:00')], [ticket({ valor: 10, hora: '10:00' })], DIA);
    expect(r.linhas.map((l) => l.situacao)).toEqual(['sem_ticket', 'confere']);
  });
});

describe('conferência de tickets — normalizações', () => {
  it('número do cupom/recibo', () => {
    expect(normalizarNumero('Venda #1A2B3C4D')).toBe('1a2b3c4d');
    expect(normalizarNumero('Baixa #0F0E0D0C')).toBe('0f0e0d0c');
    expect(normalizarNumero('#ABCDEF12')).toBe('abcdef12');
    expect(normalizarNumero('ABCDEF12')).toBe('abcdef12');
    expect(normalizarNumero('Venda')).toBeNull();
    expect(normalizarNumero(null)).toBeNull();
  });

  it('bandeira', () => {
    expect(normalizarBandeira('VISANET')).toBe('VISA');
    expect(normalizarBandeira('VISA ELECTRON')).toBe('VISA');
    expect(normalizarBandeira('REDESHOP')).toBe('MASTER');
    expect(normalizarBandeira('Maestro')).toBe('MASTER');
    expect(normalizarBandeira('elo débito')).toBe('ELO');
    expect(normalizarBandeira('')).toBeNull();
  });

  it('forma de pagamento', () => {
    expect(normalizarForma('CARTÃO CRÉDITO')).toBe('credito');
    expect(normalizarForma('CREDIÁRIO')).toBe('crediario');
    expect(normalizarForma('Espécie')).toBe('dinheiro');
    expect(normalizarForma('PIX')).toBe('pix');
  });
});
