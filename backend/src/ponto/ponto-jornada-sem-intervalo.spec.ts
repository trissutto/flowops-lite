import { PontoService } from './ponto.service';

/**
 * O SÁBADO QUE CONTINUAVA DESCONTANDO (dono, 26/09/2026).
 *
 * "Os cálculos têm que obedecer a jornada — o sábado está descontando a parte
 * da tarde mesmo cadastrado até as 13." O cadastro estava certo desde 11/09
 * (09:00–13:00 sem intervalo, previsto 4h) e o dia seguia fechando −4h: a
 * batida `auto` seguia a sequência fixa de quatro pontos, gravava a saída das
 * 13:00 como "saída almoço", e o espelho — que exigia entrada+saída — contava
 * ZERO trabalhado. Estes testes prendem o serviço inteiro à régua
 * `common/jornada-do-dia.ts`: a próxima batida, o espelho, a conferência de
 * jornada e a tela do dia.
 */

const SEG_A_SEX = ['SEG', 'TER', 'QUA', 'QUI', 'SEX'].map((dia) => ({
  dia,
  inicio: '09:00',
  fim: '18:00',
  almocoInicio: '12:00',
  almocoFim: '13:00',
  folga: false,
}));

/** Semana certa: sábado de meio período SEM intervalo (como o lote da loja grava). */
const SEMANA_44H = JSON.stringify([
  ...SEG_A_SEX,
  { dia: 'SAB', inicio: '09:00', fim: '13:00', almocoInicio: null, almocoFim: null, folga: false },
  { dia: 'DOM', folga: true },
]);

/** Batida em horário de Brasília (UTC−3). */
const bat = (tipo: string, dia: string, hhmm: string, extra: any = {}) => ({
  id: `${tipo}@${dia} ${hhmm}`,
  sellerId: 's1',
  storeId: 'loja-7',
  tipo,
  timestamp: new Date(`${dia}T${hhmm}:00-03:00`),
  source: 'face_pdv',
  justificado: false,
  faceConfidence: 0.9,
  ...extra,
});

/** Sábado 26/09/2026 batido ANTES da correção: a saída nasceu como "saída almoço". */
const SABADO = '2026-09-26';
const SABADO_MAL_ROTULADO = [bat('entrada', SABADO, '09:00'), bat('saida_almoco', SABADO, '13:00')];

const seller = (over: any = {}) => ({
  id: 's1',
  name: 'Maria',
  active: true,
  cargo: 'Vendedora',
  horarioTrabalho: SEMANA_44H,
  responsibleStoreId: 'loja-7',
  responsibleStore: { code: '07', name: 'PIRACICABA' },
  ...over,
});

function servico(opts: { seller?: any; registros?: any[] } = {}) {
  const s = opts.seller ?? seller();
  const registros = opts.registros ?? [];
  const prisma: any = {
    seller: {
      findUnique: jest.fn(async () => s),
      findMany: jest.fn(async () => [s]),
      update: jest.fn(async (args: any) => args),
    },
    pontoRegistro: {
      findMany: jest.fn(async () => registros),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ id: 'novo', ...data })),
    },
  };
  const eventos = { mapaDoMes: jest.fn(async () => ({})) };
  return { svc: new PontoService(prisma, eventos as any), prisma };
}

describe('getNextTipoForSeller — a batida `auto` obedece a jornada do dia', () => {
  const sabado13h = new Date(`${SABADO}T13:00:00-03:00`);
  const segunda13h = new Date('2026-09-21T13:00:00-03:00');

  it('sábado sem intervalo: depois da entrada, a próxima é a SAÍDA', async () => {
    const { svc } = servico({ registros: [bat('entrada', SABADO, '09:00')] });
    const r = await svc.getNextTipoForSeller('s1', sabado13h);
    expect(r.tipo).toBe('saida');
    expect(r.semIntervalo).toBe(true);
    expect(r.sequencia).toEqual(['entrada', 'saida']);
  });

  it('segunda com almoço: depois da entrada vem a saída do almoço, como sempre', async () => {
    const { svc } = servico({ registros: [bat('entrada', '2026-09-21', '09:00')] });
    const r = await svc.getNextTipoForSeller('s1', segunda13h);
    expect(r.tipo).toBe('saida_almoco');
    expect(r.semIntervalo).toBe(false);
  });

  it('sábado já com entrada e saída está completo', async () => {
    const { svc } = servico({
      registros: [bat('entrada', SABADO, '09:00'), bat('saida', SABADO, '13:00')],
    });
    expect((await svc.getNextTipoForSeller('s1', sabado13h)).tipo).toBeNull();
  });

  it('sem cadastro nenhum, continua nas quatro batidas (não há jornada a obedecer)', async () => {
    const { svc } = servico({
      seller: seller({ horarioTrabalho: null }),
      registros: [bat('entrada', SABADO, '09:00')],
    });
    expect((await svc.getNextTipoForSeller('s1', sabado13h)).tipo).toBe('saida_almoco');
  });

  it('registrar(auto) no sábado completo explica que o dia tem duas batidas', async () => {
    const { svc } = servico({
      registros: [bat('entrada', SABADO, '09:00'), bat('saida', SABADO, '13:00')],
    });
    // O relógio de produção é `new Date()`; aqui basta que HOJE tenha jornada
    // sem intervalo pra mensagem certa sair — por isso o cadastro abaixo põe
    // o mesmo turno em todos os dias.
    const todosSemIntervalo = JSON.stringify(
      ['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB', 'DOM'].map((dia) => ({
        dia, inicio: '09:00', fim: '13:00', almocoInicio: null, almocoFim: null, folga: false,
      })),
    );
    const { svc: svcHoje } = servico({
      seller: seller({ horarioTrabalho: todosSemIntervalo }),
      registros: [bat('entrada', SABADO, '09:00'), bat('saida', SABADO, '13:00')],
    });
    await expect(
      svcHoje.registrar({ sellerId: 's1', storeId: 'loja-7', tipo: 'auto', source: 'face_pdv' }),
    ).rejects.toThrow(/entrada e saída de hoje/);
    void svc;
  });
});

describe('getEspelhoMensal — o sábado fecha em zero, não em −4h', () => {
  it('"saída almoço" das 13:00 vale como saída: 4h trabalhadas, 4h previstas', async () => {
    const { svc } = servico({ registros: SABADO_MAL_ROTULADO });
    const esp = await svc.getEspelhoMensal('s1', 2026, 9);
    const dia = esp.dias.find((d: any) => d.data === SABADO);

    expect(dia.diaSemana).toBe('SAB');
    expect(dia.minPrevisto).toBe(240);
    expect(dia.minTrabalhado).toBe(240);
    expect(dia.saldoMin).toBe(0);
    expect(dia.completo).toBe(true);
    expect(dia.semIntervalo).toBe(true);
    expect(dia.reinterpretada).toBe(true);
    expect(dia.saida).not.toBeNull();
    expect(dia.saidaAlmoco).toBeNull();
    // A caixa "Ajustar" edita pelo tipo interpretado, e sabe o que o terminal gravou.
    expect(dia.registros[1]).toMatchObject({ tipo: 'saida', tipoRegistrado: 'saida_almoco' });
    expect(esp.totais.saldoMin).toBe(-esp.totais.minPrevisto + 240);
  });

  it('o mesmo par numa segunda (com almoço) continua sendo dia incompleto', async () => {
    const SEG = '2026-09-21';
    const { svc } = servico({
      registros: [bat('entrada', SEG, '09:00'), bat('saida_almoco', SEG, '13:00')],
    });
    const dia = (await svc.getEspelhoMensal('s1', 2026, 9)).dias.find((d: any) => d.data === SEG);
    expect(dia.minPrevisto).toBe(480);
    expect(dia.minTrabalhado).toBe(0);
    expect(dia.saida).toBeNull();
    expect(dia.reinterpretada).toBe(false);
    expect(dia.completo).toBe(false);
  });

  it('sábado batido certo (entrada + saída) dá o mesmo resultado', async () => {
    const { svc } = servico({
      registros: [bat('entrada', SABADO, '09:00'), bat('saida', SABADO, '13:00')],
    });
    const dia = (await svc.getEspelhoMensal('s1', 2026, 9)).dias.find((d: any) => d.data === SABADO);
    expect(dia.minTrabalhado).toBe(240);
    expect(dia.saldoMin).toBe(0);
    expect(dia.reinterpretada).toBe(false);
  });
});

describe('conferirJornada — enxerga o sábado que a sequência fixa escondia', () => {
  it('sábado com "saída almoço" no lugar da saída conta como batido e fecha "ok"', async () => {
    const { svc } = servico({ registros: SABADO_MAL_ROTULADO });
    const item: any = (await svc.conferirJornada({ dia: 'SAB', semanas: 26 })).itens[0];
    expect(item.minPrevisto).toBe(240);
    expect(item.diasComBatida).toBe(1);
    expect(item.minRealMediana).toBe(240);
    expect(item.saidaTipica).toBe('13:00');
    expect(item.difMin).toBe(0);
    expect(item.veredito).toBe('ok');
  });
});

describe('getDia — a tela do dia não deixa a funcionária "no almoço" até meia-noite', () => {
  it('sábado sem intervalo: entrada + "saída almoço" = SAIU', async () => {
    const s = seller();
    const { svc } = servico({
      registros: SABADO_MAL_ROTULADO.map((b) => ({
        ...b,
        seller: { id: s.id, name: s.name, apelido: null, cargo: s.cargo, horarioTrabalho: s.horarioTrabalho },
        store: { id: 'loja-7', code: '07', name: 'PIRACICABA' },
      })),
    });
    const r = await svc.getDia(SABADO);
    const func = r.lojas[0].funcionarias[0];
    expect(func.status).toBe('saiu');
    expect(func.batidas.map((b: any) => b.tipo)).toEqual(['entrada', 'saida']);
    expect(func.batidas[1].tipoRegistrado).toBe('saida_almoco');
    expect(func.batidas[1]).not.toHaveProperty('timestamp');
    expect(r.totais.sairam).toBe(1);
    expect(r.totais.almoco).toBe(0);
  });
});
