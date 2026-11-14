import { PontoService } from './ponto.service';

/**
 * ESPELHO ANTES DA ADMISSÃO — o dia que não cobra jornada.
 *
 * Pedido do dono (14/11/2026): "não gerar falta, nem saldo devedor em datas
 * anteriores à admissão da funcionária. Zerar o ponto em datas anteriores à
 * admissão". Caso real: Juliana, admitida em 06/11 e cadastrada em 05/11,
 * abria novembro com FALTA de 02 a 05 e −29h antes do primeiro dia.
 *
 * O que este spec prende: dia anterior à admissão sem batida vem com previsto
 * 0 e fora do total do mês; o dia da admissão conta; batida antes da ficha
 * NÃO é zerada (a ficha é que está errada) e vem carimbada; sem admissão na
 * ficha nada muda; e a data `@db.Date` (meia-noite UTC) corta no dia certo.
 */

const SEMANA = JSON.stringify([
  ...['SEG', 'TER', 'QUA', 'QUI', 'SEX'].map((dia) => ({
    dia,
    inicio: '09:00',
    fim: '18:00',
    almocoInicio: '12:00',
    almocoFim: '13:00',
    folga: false,
  })),
  { dia: 'SAB', inicio: '09:00', fim: '13:00', almocoInicio: null, almocoFim: null, folga: false },
  { dia: 'DOM', folga: true },
]);

/** Vendedora como a Juliana: cadastrada 05/11, admitida 06/11 (sexta). */
const vendedora = (over: any = {}) => ({
  id: 's-juliana',
  name: 'Juliana',
  active: true,
  cargo: 'VENDEDORA',
  horarioTrabalho: SEMANA,
  responsibleStoreId: null,
  storeCodeOrigin: '14',
  // Exatamente como o Prisma devolve um `@db.Date`: meia-noite UTC.
  dataAdmissao: new Date('2026-11-06T00:00:00.000Z'),
  ...over,
});

/** Quatro batidas de um dia útil, em horário de Brasília. */
const diaBatido = (data: string, storeId = 'loja-14') =>
  [
    ['entrada', '09:00'],
    ['saida_almoco', '12:00'],
    ['volta_almoco', '13:00'],
    ['saida', '18:00'],
  ].map(([tipo, h], i) => ({
    id: `${data}-${tipo}`,
    sellerId: 's-juliana',
    storeId,
    tipo,
    timestamp: new Date(`${data}T${h}:00-03:00`),
    source: 'face_pdv',
    justificado: false,
    ordem: i,
  }));

function servico(opts: { seller?: any; registros?: any[] } = {}) {
  const s = opts.seller ?? vendedora();
  const prisma: any = {
    seller: { findUnique: jest.fn(async () => s) },
    store: { findUnique: jest.fn(async () => ({ id: 'loja-14' })) },
    pontoRegistro: {
      findMany: jest.fn(async () => opts.registros ?? []),
      findFirst: jest.fn(async () => null),
      create: jest.fn(),
    },
  };
  const eventos = { mapaDoMes: jest.fn(async () => ({})) };
  return new PontoService(prisma, eventos as any);
}

const dia = (e: any, data: string) => e.dias.find((d: any) => d.data === data);

describe('espelho mensal — dias anteriores à admissão', () => {
  it('antes da admissão: previsto 0, saldo 0, carimbo; o dia da admissão conta', async () => {
    const svc = servico({ registros: [...diaBatido('2026-11-09'), ...diaBatido('2026-11-10')] });
    const e = await svc.getEspelhoMensal('s-juliana', 2026, 11);

    expect(e.vinculo).toEqual({ admissao: '2026-11-06' });

    for (const data of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) {
      const d = dia(e, data);
      expect(d.antesDaAdmissao).toBe(true);
      expect(d.minPrevisto).toBe(0);
      expect(d.saldoMin).toBe(0);
      expect(d.batidas).toBe(0);
      // A jornada do dia continua na resposta: se ela trabalhou, a caixa
      // "Ajustar" ainda sabe preencher — e o dia sai carimbado.
      expect(d.janela).not.toBeNull();
    }
    // Domingo 01/11 também é antes — folga continua folga, e carimbado.
    expect(dia(e, '2026-11-01')).toMatchObject({ folga: true, antesDaAdmissao: true, minPrevisto: 0 });

    // 06/11 (sexta) é o DIA da admissão: cobra a jornada inteira.
    expect(dia(e, '2026-11-06')).toMatchObject({ antesDaAdmissao: false, minPrevisto: 480, batidas: 0 });
    expect(dia(e, '2026-11-09')).toMatchObject({ antesDaAdmissao: false, minPrevisto: 480, minTrabalhado: 480 });
  });

  it('o total do mês não carrega a jornada de antes da admissão', async () => {
    const svc = servico({ registros: diaBatido('2026-11-09') });
    const e = await svc.getEspelhoMensal('s-juliana', 2026, 11);
    // Novembro/2026 começa num domingo. A partir da admissão (sexta 06):
    // dias úteis seg–sex 06, 09–13, 16–20, 23–27 e 30 = 17 × 480;
    // sábados 07, 14, 21 e 28 = 4 × 240. Nada de 02 a 05.
    const esperado = 17 * 480 + 4 * 240;
    expect(e.totais.minPrevisto).toBe(esperado);
    expect(e.totais.minTrabalhado).toBe(480);
    expect(e.totais.saldoMin).toBe(480 - esperado);
  });

  it('batida ANTES da admissão não é zerada: o dia conta e vem carimbado', async () => {
    const svc = servico({ registros: diaBatido('2026-11-04') });
    const e = await svc.getEspelhoMensal('s-juliana', 2026, 11);
    const d04 = dia(e, '2026-11-04');
    expect(d04.antesDaAdmissao).toBe(true);
    expect(d04.batidas).toBe(4);
    expect(d04.minPrevisto).toBe(480);
    expect(d04.minTrabalhado).toBe(480);
    expect(d04.saldoMin).toBe(0);
    // Os outros dias de antes seguem zerados.
    expect(dia(e, '2026-11-03').minPrevisto).toBe(0);
  });

  it('sem data de admissão na ficha nada muda: o mês inteiro cobra jornada', async () => {
    const svc = servico({ seller: vendedora({ dataAdmissao: null }) });
    const e = await svc.getEspelhoMensal('s-juliana', 2026, 11);
    expect(e.vinculo).toEqual({ admissao: null });
    expect(dia(e, '2026-11-02')).toMatchObject({ antesDaAdmissao: false, minPrevisto: 480 });
    expect(e.dias.every((d: any) => d.antesDaAdmissao === false)).toBe(true);
  });

  it('admissão em outro mês: mês anterior inteiro zerado, mês seguinte intacto', async () => {
    const svc = servico();
    const out = await svc.getEspelhoMensal('s-juliana', 2026, 10);
    expect(out.dias.every((d: any) => d.antesDaAdmissao && d.minPrevisto === 0)).toBe(true);
    expect(out.totais.minPrevisto).toBe(0);
    expect(out.totais.saldoMin).toBe(0);

    const dez = await svc.getEspelhoMensal('s-juliana', 2026, 12);
    expect(dez.dias.some((d: any) => d.antesDaAdmissao)).toBe(false);
    expect(dez.totais.minPrevisto).toBeGreaterThan(0);
  });

  it('a loja consolidada não conta FALTA antes da admissão', async () => {
    const svc = servico({ registros: diaBatido('2026-11-09') });
    (svc as any).prisma.seller.findMany = jest.fn(async () => [{ id: 's-juliana', name: 'Juliana' }]);
    const loja = await svc.getEspelhoStore('loja-14', 2026, 11);
    const item = loja.items[0];
    // Faltas: 06 (sexta, dia da admissão, sem batida), 07 (sáb), 10–13,
    // 14 (sáb), 16–20, 21, 23–27, 28, 30 — tudo que é previsto sem batida
    // a partir da admissão, e NADA de 02 a 05.
    const diasPrevistosDesde06 = 17 + 4; // úteis + sábados
    expect(item.diasFalta).toBe(diasPrevistosDesde06 - 1); // 09/11 foi batido
  });
});
