import { BadRequestException } from '@nestjs/common';
import { PontoService } from './ponto.service';

/**
 * BATIDA LANÇADA À MÃO NUM DIA SEM BATIDA — a loja da funcionária.
 *
 * Pedido do dono (14/11/2026): "permitir inserir os horários manualmente nos
 * dias em que não ocorreram batidas de ponto". A caixa "Ajustar" do espelho
 * já criava batida em campo vazio, mas mandava `storeId` tirado da primeira
 * batida do dia — e, num dia vazio, do `seller.storeId` do espelho, que era
 * só `responsibleStoreId`: campo de LÍDER/GERENTE. Vendedora e caixa chegam
 * do Wincred com `storeCodeOrigin` e esse campo vazio (62 das 73 ativas em
 * 14/11), então a FALTA de quem esqueceu de bater não tinha conserto.
 *
 * O que este spec prende: a loja sai do cadastro (responsável → loja de
 * origem → última batida), o espelho a devolve preenchida, e sem nada disso
 * o erro SOBE em vez de gravar batida numa loja inventada.
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

/** Caixa da loja 10, como a Ariadne: só `storeCodeOrigin`, sem responsável. */
const caixa = (over: any = {}) => ({
  id: 's-ariadne',
  name: 'Ariadne',
  active: true,
  cargo: 'CAIXA',
  horarioTrabalho: SEMANA,
  responsibleStoreId: null,
  storeCodeOrigin: '10',
  ...over,
});

function servico(opts: { seller?: any; lojas?: Record<string, string>; ultima?: any; registros?: any[] } = {}) {
  const s = opts.seller ?? caixa();
  const lojas = opts.lojas ?? { '10': 'loja-10' };
  const prisma: any = {
    seller: { findUnique: jest.fn(async () => s) },
    store: {
      findUnique: jest.fn(async ({ where }: any) =>
        lojas[where.code] ? { id: lojas[where.code] } : null,
      ),
    },
    pontoRegistro: {
      findMany: jest.fn(async () => opts.registros ?? []),
      findFirst: jest.fn(async () => opts.ultima ?? null),
      create: jest.fn(async ({ data }: any) => ({ id: 'novo', ...data })),
    },
  };
  const eventos = { mapaDoMes: jest.fn(async () => ({})) };
  const svc = new PontoService(prisma, eventos as any);
  return { svc, prisma };
}

const manual = (over: any = {}) => ({
  sellerId: 's-ariadne',
  tipo: 'entrada',
  timestamp: '2026-11-03T12:00:00.000Z', // 09:00 BR
  justificativa: 'esqueceu de bater',
  ...over,
});

describe('criarManual sem storeId — a loja sai do cadastro', () => {
  it('caixa com loja de origem: grava na loja do code', async () => {
    const { svc, prisma } = servico();
    const r = await svc.criarManual(manual());
    expect(r.storeId).toBe('loja-10');
    expect(r.source).toBe('manual_admin');
    expect(r.justificado).toBe(true);
    expect(prisma.store.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: '10' } }),
    );
  });

  it('gerente com responsável: usa o responsável, sem consultar a loja por code', async () => {
    const { svc, prisma } = servico({ seller: caixa({ responsibleStoreId: 'loja-chefe' }) });
    const r = await svc.criarManual(manual());
    expect(r.storeId).toBe('loja-chefe');
    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });

  it('sem cadastro de loja: cai na loja da última batida dela', async () => {
    const { svc } = servico({
      seller: caixa({ storeCodeOrigin: null }),
      ultima: { storeId: 'loja-da-ultima' },
    });
    const r = await svc.criarManual(manual());
    expect(r.storeId).toBe('loja-da-ultima');
  });

  it('code que não existe mais: ainda tenta a última batida', async () => {
    const { svc } = servico({ lojas: {}, ultima: { storeId: 'loja-da-ultima' } });
    const r = await svc.criarManual(manual());
    expect(r.storeId).toBe('loja-da-ultima');
  });

  it('sem nada: erro honesto com o nome dela, e nada é gravado', async () => {
    const { svc, prisma } = servico({ seller: caixa({ storeCodeOrigin: null }) });
    await expect(svc.criarManual(manual())).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.criarManual(manual())).rejects.toThrow(/Ariadne/);
    expect(prisma.pontoRegistro.create).not.toHaveBeenCalled();
  });

  it('storeId informado continua valendo como veio', async () => {
    const { svc, prisma } = servico();
    const r = await svc.criarManual(manual({ storeId: 'loja-do-dia' }));
    expect(r.storeId).toBe('loja-do-dia');
    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });

  it('justificativa curta e timestamp inválido são recusados antes de gravar', async () => {
    const { svc, prisma } = servico();
    await expect(svc.criarManual(manual({ justificativa: 'ok' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.criarManual(manual({ timestamp: 'ontem' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.pontoRegistro.create).not.toHaveBeenCalled();
  });
});

describe('espelho mensal — seller.storeId pra caixa "Ajustar"', () => {
  it('caixa sem responsável devolve a loja de origem (era null)', async () => {
    const { svc } = servico();
    const e = await svc.getEspelhoMensal('s-ariadne', 2026, 11);
    expect(e.seller.storeId).toBe('loja-10');
    // O dia sem batida continua vindo como dia a corrigir, com a jornada.
    const d03 = e.dias.find((d: any) => d.data === '2026-11-03');
    expect(d03.batidas).toBe(0);
    expect(d03.janela).toEqual({
      inicio: '09:00',
      fim: '18:00',
      almocoInicio: '12:00',
      almocoFim: '13:00',
    });
    expect(d03.semIntervalo).toBe(false);
  });

  it('gerente continua com o responsável', async () => {
    const { svc } = servico({ seller: caixa({ responsibleStoreId: 'loja-chefe' }) });
    const e = await svc.getEspelhoMensal('s-ariadne', 2026, 11);
    expect(e.seller.storeId).toBe('loja-chefe');
  });

  it('sábado sem intervalo vem marcado — a caixa preenche só entrada e saída', async () => {
    const { svc } = servico();
    const e = await svc.getEspelhoMensal('s-ariadne', 2026, 11);
    const sab = e.dias.find((d: any) => d.data === '2026-11-07');
    expect(sab.semIntervalo).toBe(true);
    expect(sab.janela).toEqual({
      inicio: '09:00',
      fim: '13:00',
      almocoInicio: null,
      almocoFim: null,
    });
  });
});
