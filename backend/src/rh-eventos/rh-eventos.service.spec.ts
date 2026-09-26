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
  // O service de documentos não é exercido por estes testes (nenhum deles sobe
  // arquivo) — entra como stub só pra satisfazer o construtor.
  const docs: any = { upload: jest.fn() };
  return { svc: new RhEventosService(prisma, docs), prisma, docs };
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
    const svc = new RhEventosService(prisma, { upload: jest.fn() } as any);
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

describe('descontosFolha — o que a folha tem que fazer no mês', () => {
  const seller = (salario: number) => ({ id: 's1', name: 'Fulana', salarioBase: salario });

  it('mês sem desconto devolve lista vazia, não linha zerada', async () => {
    const { svc } = servicoCom([
      { sellerId: 's1', tipo: 'ATESTADO_MEDICO', seller: seller(3000),
        dataInicio: dbDate('2026-08-10'), dataFim: dbDate('2026-08-12') },
    ]);
    const r = await svc.descontosFolha(2026, 8);
    expect(r.itens).toEqual([]);
    expect(r.totalValor).toBe(0);
  });

  // Salário 3000 → dia = 100. Uma falta = 1 dia + 1 DSR = R$ 200.
  it('uma falta custa dois dias de salário', async () => {
    const { svc } = servicoCom([
      { sellerId: 's1', tipo: 'FALTA_INJUSTIFICADA', seller: seller(3000),
        dataInicio: dbDate('2026-08-25'), dataFim: dbDate('2026-08-25') },
    ]);
    const r = await svc.descontosFolha(2026, 8);
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0].diasDescontados).toBe(1);
    expect(r.itens[0].dsrPerdidos).toBe(1);
    expect(r.itens[0].valorDesconto).toBe(200);
    expect(r.totalValor).toBe(200);
  });

  // A falta atravessa a virada do mês: agosto só pode cobrar os dias de agosto.
  it('evento que cruza a virada do mês é recortado no mês pedido', async () => {
    const { svc } = servicoCom([
      { sellerId: 's1', tipo: 'FALTA_INJUSTIFICADA', seller: seller(3000),
        dataInicio: dbDate('2026-08-30'), dataFim: dbDate('2026-09-02') },
    ]);
    const r = await svc.descontosFolha(2026, 8);
    expect(r.itens[0].diasDescontados).toBe(2); // 30 e 31 de agosto
  });

  it('sem salário cadastrado conta os dias mas não inventa valor', async () => {
    const { svc } = servicoCom([
      { sellerId: 's1', tipo: 'FALTA_INJUSTIFICADA', seller: seller(0),
        dataInicio: dbDate('2026-08-25'), dataFim: dbDate('2026-08-25') },
    ]);
    const r = await svc.descontosFolha(2026, 8);
    expect(r.itens[0].diasTotais).toBe(2);
    expect(r.itens[0].valorDesconto).toBe(0);
  });

  it('tabela ausente não derruba a folha', async () => {
    const prisma: any = {
      sellerEvento: { findMany: jest.fn(async () => { throw new Error('nope'); }) },
    };
    const svc = new RhEventosService(prisma, { upload: jest.fn() } as any);
    await expect(svc.descontosFolha(2026, 8)).resolves.toEqual({
      ano: 2026, mes: 8, itens: [], totalDias: 0, totalValor: 0,
    });
  });
});

/**
 * O ANEXO NÃO TRANCA MAIS O LANÇAMENTO (ordem do dono, 11/09/2026).
 *
 * O teste existe porque a regra antiga era invisível pelo lado certo: sem
 * arquivo o `criar` devolvia 400 e, na operação, o efeito não era "atestado
 * sempre digitalizado" — era o dia ficar contado como FALTA até o papel chegar
 * na matriz. O que não pode voltar em silêncio junto com a trava é a
 * PENDÊNCIA: evento sem papel tem que continuar aparecendo como devendo.
 */
describe('atestado sem o papel — lança agora, cobra depois', () => {
  function servicoQueGrava() {
    const criados: any[] = [];
    const prisma: any = {
      sellerEvento: {
        create: jest.fn(async ({ data }: any) => {
          criados.push(data);
          return { id: 'ev1', ...data };
        }),
        findMany: jest.fn(async () => []),
      },
      seller: {
        findUnique: jest.fn(async () => ({
          id: 's1', name: 'Maria', responsibleStoreId: 'loja13',
        })),
      },
    };
    const svc = new RhEventosService(prisma, { upload: jest.fn() } as any);
    return { svc, criados };
  }

  const autor = { id: 'u1', nome: 'Supervisão' };

  it('atestado de 15 dias entra SEM documento, num lançamento só', async () => {
    const { svc, criados } = servicoQueGrava();
    await expect(
      svc.criar(
        {
          sellerId: 's1',
          tipo: 'ATESTADO_MEDICO',
          dataInicio: '2026-09-01',
          dataFim: '2026-09-15',
        },
        autor,
      ),
    ).resolves.toBeTruthy();
    expect(criados[0].documentoId).toBeNull();
    expect(criados[0].dataInicio).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(criados[0].dataFim).toEqual(new Date('2026-09-15T00:00:00.000Z'));
  });

  it('a pendência do papel aparece na listagem', async () => {
    const prisma: any = {
      sellerEvento: {
        findMany: jest.fn(async () => [
          { id: 'a', tipo: 'ATESTADO_MEDICO', documentoId: null },
          { id: 'b', tipo: 'ATESTADO_MEDICO', documentoId: 'doc9' },
          // Falta não pede papel nenhum: não pode entrar na fila de cobrança.
          { id: 'c', tipo: 'FALTA_INJUSTIFICADA', documentoId: null },
        ]),
      },
    };
    const svc = new RhEventosService(prisma, { upload: jest.fn() } as any);
    const linhas = await svc.listar({});
    expect(linhas.map((l: any) => [l.id, l.documentoPendente])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
  });

  it('o teto do art. 473 continua de pé — a trava que caiu foi só a do papel', async () => {
    const { svc } = servicoQueGrava();
    await expect(
      svc.criar(
        { sellerId: 's1', tipo: 'GALA', dataInicio: '2026-09-01', dataFim: '2026-09-10' },
        autor,
      ),
    ).rejects.toThrow(/máximo 3 dia/i);
  });
});

/**
 * ATESTADO DE HORAS (dono, 26/09/2026): "abrindo um campo para colocarmos o
 * horário de até tal hora — esta jornada não desconta do funcionário".
 *
 * A régua já abatia só a janela desde 28/08; o que faltava era a PORTA: a
 * caixa "Ajustar dia" do espelho mandava sempre dia inteiro. E a porta ganhou
 * uma trava: parcial sem hora não entra. Antes era gravado e virava dia
 * inteiro calado — 8h abonadas de uma consulta de 2h.
 */
describe('atestado de HORAS — só a janela, e a janela completa', () => {
  const SEMANA = JSON.stringify([
    { dia: 'SEG', inicio: '09:00', fim: '18:00', almocoInicio: '12:00', almocoFim: '13:00', folga: false },
    { dia: 'DOM', folga: true },
  ]);

  function servico() {
    const criados: any[] = [];
    const prisma: any = {
      sellerEvento: {
        create: jest.fn(async ({ data }: any) => {
          criados.push(data);
          return { id: 'ev1', ...data };
        }),
        findUnique: jest.fn(),
        update: jest.fn(async ({ data }: any) => ({ id: 'ev1', ...data })),
        findMany: jest.fn(async () => []),
      },
      seller: {
        findUnique: jest.fn(async () => ({
          id: 's1', name: 'Maria', responsibleStoreId: 'loja13', horarioTrabalho: SEMANA,
        })),
      },
    };
    return { svc: new RhEventosService(prisma, { upload: jest.fn() } as any), criados, prisma };
  }
  const autor = { id: 'u1', nome: 'Supervisão' };

  it('grava só a janela: das 09:00 até 11:00', async () => {
    const { svc, criados } = servico();
    await svc.criar(
      {
        sellerId: 's1', tipo: 'ATESTADO_MEDICO', dataInicio: '2026-09-28',
        diaInteiro: false, horaInicio: '9:00', horaFim: '11:00',
      },
      autor,
    );
    expect(criados[0]).toMatchObject({ diaInteiro: false, horaInicio: '09:00', horaFim: '11:00' });
  });

  it('"só algumas horas" com o até em branco é 400 — não vira dia inteiro calado', async () => {
    const { svc, criados } = servico();
    await expect(
      svc.criar(
        {
          sellerId: 's1', tipo: 'ATESTADO_MEDICO', dataInicio: '2026-09-28',
          diaInteiro: false, horaInicio: '09:00', horaFim: '',
        },
        autor,
      ),
    ).rejects.toThrow(/até que horas/i);
    expect(criados).toHaveLength(0);
  });

  it('até antes do das também é 400', async () => {
    const { svc } = servico();
    await expect(
      svc.criar(
        {
          sellerId: 's1', tipo: 'ATESTADO_MEDICO', dataInicio: '2026-09-28',
          diaInteiro: false, horaInicio: '11:00', horaFim: '09:00',
        },
        autor,
      ),
    ).rejects.toThrow(/maior que a de início/i);
  });

  it('tipo que não admite parcial grava dia inteiro mesmo com hora digitada', async () => {
    const { svc, criados } = servico();
    await svc.criar(
      {
        sellerId: 's1', tipo: 'FERIAS', dataInicio: '2026-09-28',
        diaInteiro: false, horaInicio: '09:00', horaFim: '11:00',
      },
      autor,
    );
    expect(criados[0]).toMatchObject({ diaInteiro: true, horaInicio: null, horaFim: null });
  });

  it('editar só o "até" mantém o "das" que já estava gravado', async () => {
    const { svc, prisma } = servico();
    prisma.sellerEvento.findUnique.mockResolvedValue({
      id: 'ev1', tipo: 'ATESTADO_MEDICO',
      dataInicio: dbDate('2026-09-28'), dataFim: dbDate('2026-09-28'),
      diaInteiro: false, horaInicio: '09:00', horaFim: '11:00',
      documentoId: null, observacoes: null, canceladoAt: null,
    });
    const r: any = await svc.editar('ev1', { horaFim: '12:00' });
    expect(r).toMatchObject({ diaInteiro: false, horaInicio: '09:00', horaFim: '12:00' });
  });

  describe('previa — o número que a tela mostra antes de gravar', () => {
    it('consulta da entrada até 11:00 numa segunda: abona 2h, ela deve 6h', async () => {
      const { svc } = servico();
      const p = await svc.previa({
        sellerId: 's1', data: '2026-09-28', tipo: 'ATESTADO_MEDICO',
        diaInteiro: false, horaInicio: '09:00', horaFim: '11:00',
      });
      expect(p).toMatchObject({
        data: '2026-09-28', diaSemana: 'SEG', folga: false, semCadastro: false,
        minPrevisto: 480, minAfetados: 120, minRestantes: 360,
        efeito: 'abona', parcial: true, foraDaJornada: false,
      });
      expect(p.janela).toEqual({
        inicio: '09:00', fim: '18:00', almocoInicio: '12:00', almocoFim: '13:00',
      });
    });

    it('sem hora devolve a jornada do dia — é como a tela preenche o "das"', async () => {
      const p = await servico().svc.previa({
        sellerId: 's1', data: '2026-09-28', tipo: 'ATESTADO_MEDICO',
      });
      expect(p.janela?.inicio).toBe('09:00');
      expect(p.parcial).toBe(false);
      expect(p.minAfetados).toBe(480);
    });

    it('hora fora da jornada avisa em vez de prometer abono', async () => {
      const p = await servico().svc.previa({
        sellerId: 's1', data: '2026-09-28', tipo: 'ATESTADO_MEDICO',
        diaInteiro: false, horaInicio: '07:00', horaFim: '08:30',
      });
      expect(p.foraDaJornada).toBe(true);
      expect(p.minAfetados).toBe(0);
    });

    it('domingo é folga no cadastro: previsto zero, e a tela sabe que é folga', async () => {
      const p = await servico().svc.previa({
        sellerId: 's1', data: '2026-09-27', tipo: 'ATESTADO_MEDICO',
      });
      expect(p.folga).toBe(true);
      expect(p.minPrevisto).toBe(0);
    });

    it('recusa tipo desconhecido, data torta e parcial sem hora', async () => {
      const { svc } = servico();
      await expect(
        svc.previa({ sellerId: 's1', data: '2026-09-28', tipo: 'ATESTADO' }),
      ).rejects.toThrow(/desconhecido/i);
      await expect(
        svc.previa({ sellerId: 's1', data: '28/09/2026', tipo: 'ATESTADO_MEDICO' }),
      ).rejects.toThrow(/inválida/i);
      await expect(
        svc.previa({
          sellerId: 's1', data: '2026-09-28', tipo: 'ATESTADO_MEDICO',
          diaInteiro: false, horaInicio: '09:00',
        }),
      ).rejects.toThrow(/até que horas/i);
    });
  });
});
