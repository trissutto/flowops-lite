import { RhEventosService } from './rh-eventos.service';

/**
 * Sem banco: só a aritmética de data, que é onde um off-by-one come o último
 * dia do atestado sem ninguém perceber. Coluna `@db.Date` volta do Prisma
 * SEMPRE como 00:00Z — os fixtures imitam isso de propósito.
 */
const dbDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

function servicoCom(linhas: any[]) {
  const prisma: any = {
    sellerEvento: {
      findMany: jest.fn(async () => linhas),
    },
    seller: { findUnique: jest.fn() },
  };
  return { svc: new RhEventosService(prisma), prisma };
}

describe('mapaDoMes — um evento vira N dias', () => {
  it('atestado de 3 dias aparece nos TRÊS dias, inclusive no último', async () => {
    const { svc } = servicoCom([
      {
        tipo: 'ATESTADO_MEDICO',
        dataInicio: dbDate('2026-08-10'),
        dataFim: dbDate('2026-08-12'),
        diaInteiro: true,
        horaInicio: null,
        horaFim: null,
      },
    ]);
    const mapa = await svc.mapaDoMes('s1', 2026, 8);
    expect(Object.keys(mapa).sort()).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
    expect(mapa['2026-08-12'][0].tipo).toBe('ATESTADO_MEDICO');
  });

  it('evento de um dia só ocupa esse dia', async () => {
    const { svc } = servicoCom([
      {
        tipo: 'FALTA_INJUSTIFICADA',
        dataInicio: dbDate('2026-08-05'),
        dataFim: dbDate('2026-08-05'),
        diaInteiro: true,
        horaInicio: null,
        horaFim: null,
      },
    ]);
    const mapa = await svc.mapaDoMes('s1', 2026, 8);
    expect(Object.keys(mapa)).toEqual(['2026-08-05']);
  });

  it('preserva as horas do parcial — é o que faz o abate ser parcial', async () => {
    const { svc } = servicoCom([
      {
        tipo: 'ATESTADO_MEDICO',
        dataInicio: dbDate('2026-08-07'),
        dataFim: dbDate('2026-08-07'),
        diaInteiro: false,
        horaInicio: '08:00',
        horaFim: '12:00',
      },
    ]);
    const mapa = await svc.mapaDoMes('s1', 2026, 8);
    expect(mapa['2026-08-07'][0]).toEqual({
      tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: '08:00', horaFim: '12:00',
    });
  });

  it('dois eventos no mesmo dia ficam os dois', async () => {
    const { svc } = servicoCom([
      { tipo: 'ATESTADO_MEDICO', dataInicio: dbDate('2026-08-03'), dataFim: dbDate('2026-08-03'),
        diaInteiro: false, horaInicio: '09:00', horaFim: '12:00' },
      { tipo: 'SAIDA_ANTECIPADA', dataInicio: dbDate('2026-08-03'), dataFim: dbDate('2026-08-03'),
        diaInteiro: false, horaInicio: '16:00', horaFim: '18:00' },
    ]);
    const mapa = await svc.mapaDoMes('s1', 2026, 8);
    expect(mapa['2026-08-03']).toHaveLength(2);
  });

  // A janela do mês é meia-noite UTC nas duas pontas: com meio-dia, o evento
  // que TERMINA no dia 1 e o que COMEÇA no dia 31 saíam da busca.
  it('busca o mês com bordas em 00:00Z', async () => {
    const { svc, prisma } = servicoCom([]);
    await svc.mapaDoMes('s1', 2026, 8);
    const where = prisma.sellerEvento.findMany.mock.calls[0][0].where;
    expect(where.dataInicio.lte.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(where.dataFim.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(where.canceladoAt).toBeNull();
  });

  it('tabela ainda não criada não derruba o espelho', async () => {
    const prisma: any = {
      sellerEvento: { findMany: jest.fn(async () => { throw new Error('relation does not exist'); }) },
    };
    const svc = new RhEventosService(prisma);
    await expect(svc.mapaDoMes('s1', 2026, 8)).resolves.toEqual({});
  });
});

describe('faltasInjustificadas — o número do art. 130', () => {
  it('conta só o que é falta injustificada', async () => {
    const { svc } = servicoCom([
      { tipo: 'FALTA_INJUSTIFICADA', dataInicio: dbDate('2026-03-02'), dataFim: dbDate('2026-03-03') },
      { tipo: 'ATESTADO_MEDICO', dataInicio: dbDate('2026-04-01'), dataFim: dbDate('2026-04-10') },
      { tipo: 'FALTA_INJUSTIFICADA', dataInicio: dbDate('2026-05-06'), dataFim: dbDate('2026-05-06') },
    ]);
    const n = await svc.faltasInjustificadas('s1', dbDate('2026-01-01'), dbDate('2026-12-31'));
    expect(n).toBe(3); // 2 dias de março + 1 de maio; o atestado não conta
  });

  it('corta a falta que atravessa a borda do período aquisitivo', async () => {
    const { svc } = servicoCom([
      { tipo: 'FALTA_INJUSTIFICADA', dataInicio: dbDate('2026-05-30'), dataFim: dbDate('2026-06-03') },
    ]);
    // Período fecha em 31/05: só os dias 30 e 31 são deste ciclo.
    const n = await svc.faltasInjustificadas('s1', dbDate('2026-01-01'), dbDate('2026-05-31'));
    expect(n).toBe(2);
  });
});

describe('foraHoje — quem está fora de verdade', () => {
  const linha = (tipo: string) => ({
    id: `id-${tipo}`,
    sellerId: 's1',
    tipo,
    storeId: 'loja1',
    diaInteiro: true,
    horaInicio: null,
    horaFim: null,
    dataInicio: dbDate('2026-08-28'),
    dataFim: dbDate('2026-08-28'),
    seller: { id: 's1', name: 'Fulana', apelido: null },
    store: { id: 'loja1', code: '01', name: 'Matriz' },
  });

  it('atestado e férias entram; falta e advertência NÃO', async () => {
    const { svc } = servicoCom([
      linha('ATESTADO_MEDICO'),
      linha('FERIAS'),
      linha('FALTA_INJUSTIFICADA'),
      linha('ADVERTENCIA'),
    ]);
    const fora = await svc.foraHoje('loja1', '2026-08-28');
    expect(fora.map((f) => f.tipo).sort()).toEqual(['ATESTADO_MEDICO', 'FERIAS']);
  });

  // Coluna Date volta 00:00Z, que em São Paulo é 21:00 da véspera: converter
  // pro fuso BR aqui devolveria o dia anterior no "até".
  it('a data-fim mostrada é o dia da coluna, não o dia BR de 00:00Z', async () => {
    const { svc } = servicoCom([linha('ATESTADO_MEDICO')]);
    const fora = await svc.foraHoje('loja1', '2026-08-28');
    expect(fora[0].ate).toBe('2026-08-28');
  });

  it('busca o dia com âncora 00:00Z pra pegar o último dia do evento', async () => {
    const { svc, prisma } = servicoCom([]);
    await svc.foraHoje('loja1', '2026-08-28');
    const where = prisma.sellerEvento.findMany.mock.calls[0][0].where;
    expect(where.dataInicio.lte.toISOString()).toBe('2026-08-28T00:00:00.000Z');
    expect(where.dataFim.gte.toISOString()).toBe('2026-08-28T00:00:00.000Z');
  });
});
