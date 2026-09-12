import { PontoService } from './ponto.service';

/**
 * JORNADA CADASTRADA — o sábado que descontava 4h (dono, 11/09/2026).
 *
 * O espelho nunca inventa hora: `minPrevisto` sai inteiro de
 * `Seller.horarioTrabalho`. Quando o cadastro diz sábado de 8h e a loja fecha
 * 13:00, o saldo nasce −4h TODO sábado, sem erro, sem alerta, sem ninguém
 * saber de onde vem. Estes testes prendem as duas metades da correção:
 * enxergar a divergência, e consertá-la sem estragar o resto da semana.
 */

const SEG_A_SEX = ['SEG', 'TER', 'QUA', 'QUI', 'SEX'].map((dia) => ({
  dia,
  inicio: '09:00',
  fim: '18:00',
  almocoInicio: '12:00',
  almocoFim: '13:00',
  folga: false,
}));

/** Semana de 48h: o "padrão" que a ficha oferecia antes de 11/09. */
const SEMANA_48H = JSON.stringify([
  ...SEG_A_SEX,
  { dia: 'SAB', inicio: '09:00', fim: '18:00', almocoInicio: '12:00', almocoFim: '13:00', folga: false },
  { dia: 'DOM', folga: true },
]);

/** Sábado real de quem fecha ao meio-dia: 09:00–13:00, sem intervalo. */
const SABADO_REAL = { inicio: '09:00', fim: '13:00' };

/** Um sábado com entrada 09:00 e saída 13:00, no fuso BR. */
function sabadoBatido(sellerId: string, dia: string) {
  return [
    { sellerId, tipo: 'entrada', timestamp: new Date(`${dia}T12:00:00.000Z`) }, // 09:00 BR
    { sellerId, tipo: 'saida', timestamp: new Date(`${dia}T16:00:00.000Z`) }, // 13:00 BR
  ];
}

function servico(sellers: any[], registros: any[] = []) {
  const updates: any[] = [];
  const prisma: any = {
    seller: {
      findMany: jest.fn(async () => sellers),
      update: jest.fn(async (args: any) => {
        updates.push(args);
        return args;
      }),
    },
    pontoRegistro: { findMany: jest.fn(async () => registros) },
  };
  const svc = new PontoService(prisma, { mapaDoMes: jest.fn() } as any);
  return { svc, updates, prisma };
}

const seller = (over: any = {}) => ({
  id: 's1',
  name: 'Maria',
  horarioTrabalho: SEMANA_48H,
  responsibleStoreId: 'loja-piracicaba',
  responsibleStore: { code: '07', name: 'PIRACICABA' },
  ...over,
});

describe('conferirJornada — o cadastro cobra mais do que a loja abre', () => {
  it('acusa o sábado de 8h em quem bate 4h, com o tamanho do buraco', async () => {
    // Sábados reais de setembro/2026: 05 e 12.
    const { svc } = servico(
      [seller()],
      [...sabadoBatido('s1', '2026-09-05'), ...sabadoBatido('s1', '2026-09-12')],
    );

    const r = await svc.conferirJornada({ dia: 'SAB', semanas: 26 });
    const item: any = r.itens[0];

    expect(item.minPrevisto).toBe(480); // 8h no papel
    expect(item.minRealMediana).toBe(240); // 4h na porta
    expect(item.difMin).toBe(-240); // as 4h que o espelho tira toda semana
    expect(item.saidaTipica).toBe('13:00');
    expect(item.veredito).toBe('cadastro_maior');
    expect(r.totais?.minDescontadosPorSemana).toBe(240);
  });

  it('sábado cadastrado certo (09:00–13:00 sem almoço) fecha em zero', async () => {
    const semana = JSON.stringify([
      ...SEG_A_SEX,
      { dia: 'SAB', ...SABADO_REAL, almocoInicio: '13:00', almocoFim: '13:00', folga: false },
      { dia: 'DOM', folga: true },
    ]);
    const { svc } = servico(
      [seller({ horarioTrabalho: semana })],
      sabadoBatido('s1', '2026-09-05'),
    );

    const item: any = (await svc.conferirJornada({ dia: 'SAB', semanas: 26 })).itens[0];
    // Almoço com início = fim é como a ficha diz "sem intervalo": 4h cheias.
    expect(item.minPrevisto).toBe(240);
    expect(item.difMin).toBe(0);
    expect(item.veredito).toBe('ok');
  });

  it('sem batida no dia não vira acusação — "descontando" ali seria chute', async () => {
    const { svc } = servico([seller()], []);
    const item: any = (await svc.conferirJornada({ dia: 'SAB' })).itens[0];
    expect(item.veredito).toBe('sem_batida');
    expect(item.difMin).toBeNull();
    expect(item.minPrevisto).toBe(480);
  });

  it('só olha o dia da semana pedido — quarta-feira não entra na conta do sábado', async () => {
    const { svc } = servico(
      [seller()],
      sabadoBatido('s1', '2026-09-09'), // uma quarta
    );
    const item: any = (await svc.conferirJornada({ dia: 'SAB', semanas: 26 })).itens[0];
    expect(item.diasComBatida).toBe(0);
  });
});

describe('aplicarDiaDaSemana — conserta a loja inteira sem tocar no resto', () => {
  const alvo = { storeId: 'loja-piracicaba', dia: 'SAB', ...SABADO_REAL };

  it('troca só o sábado; segunda a sexta e o domingo ficam intactos', async () => {
    const { svc, updates } = servico([seller()]);
    const r = await svc.aplicarDiaDaSemana(alvo);

    expect(r.alteradas).toBe(1);
    const salvo = JSON.parse(updates[0].data.horarioTrabalho);
    expect(salvo.map((t: any) => t.dia)).toEqual(['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB', 'DOM']);
    expect(salvo.find((t: any) => t.dia === 'SAB')).toEqual({
      dia: 'SAB',
      inicio: '09:00',
      fim: '13:00',
      almocoInicio: null,
      almocoFim: null,
      folga: false,
    });
    expect(salvo.find((t: any) => t.dia === 'SEG').fim).toBe('18:00');
    expect(salvo.find((t: any) => t.dia === 'DOM').folga).toBe(true);
  });

  it('quem já está certa não é reescrita — o lote não inventa mudança', async () => {
    const certa = JSON.stringify([
      ...SEG_A_SEX,
      { dia: 'SAB', inicio: '09:00', fim: '13:00', almocoInicio: null, almocoFim: null, folga: false },
      { dia: 'DOM', folga: true },
    ]);
    const { svc, updates } = servico([seller({ horarioTrabalho: certa })]);
    const r = await svc.aplicarDiaDaSemana(alvo);
    expect(r.alteradas).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('funcionária sem semana cadastrada é PULADA, não vira "só trabalha sábado"', async () => {
    const { svc, updates } = servico([seller({ horarioTrabalho: null })]);
    const r = await svc.aplicarDiaDaSemana(alvo);
    expect(r.alteradas).toBe(0);
    expect(r.puladas[0].motivo).toBe('sem horário cadastrado');
    expect(updates).toHaveLength(0);
  });

  it('cadastro ilegível é pulado em vez de sobrescrito', async () => {
    const { svc, updates } = servico([seller({ horarioTrabalho: '{quebrado' })]);
    const r = await svc.aplicarDiaDaSemana(alvo);
    expect(r.puladas[0].motivo).toBe('horário ilegível');
    expect(updates).toHaveLength(0);
  });

  it('folga do sábado também é uma resposta válida', async () => {
    const { svc, updates } = servico([seller()]);
    await svc.aplicarDiaDaSemana({ storeId: 'loja-piracicaba', dia: 'SAB', folga: true });
    const salvo = JSON.parse(updates[0].data.horarioTrabalho);
    expect(salvo.find((t: any) => t.dia === 'SAB')).toEqual({ dia: 'SAB', folga: true });
  });

  it('recusa hora inválida e dia invertido em vez de gravar lixo', async () => {
    const { svc } = servico([seller()]);
    await expect(
      svc.aplicarDiaDaSemana({ storeId: 'x', dia: 'SAB', inicio: '25:00', fim: '13:00' }),
    ).rejects.toThrow(/inválida/i);
    await expect(
      svc.aplicarDiaDaSemana({ storeId: 'x', dia: 'SAB', inicio: '13:00', fim: '09:00' }),
    ).rejects.toThrow(/depois da entrada/i);
    await expect(
      svc.aplicarDiaDaSemana({ storeId: 'x', dia: 'SABADO', inicio: '09:00', fim: '13:00' }),
    ).rejects.toThrow(/Dia da semana inválido/i);
  });
});
