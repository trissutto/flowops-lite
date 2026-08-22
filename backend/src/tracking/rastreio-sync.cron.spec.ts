import { RastreioSyncCron } from './rastreio-sync.cron';

/**
 * O que estes testes protegem: a RECONCILIAÇÃO (22/08).
 *
 * 255 pedidos ficaram `shipped` com o rastreio já dizendo entregue porque a
 * regra da estreia tirava o objeto do gancho de promoção e a fila descarta
 * `entregue` pra sempre. O passo novo é a única coisa que revisita esse
 * estado — se ele parar de rodar, o buraco volta em silêncio.
 */
function montar(opts: { presos?: Array<{ codigo: string }>; env?: Record<string, string | undefined> } = {}) {
  const queryRawUnsafe = jest.fn().mockResolvedValue(opts.presos ?? []);
  const cron = new RastreioSyncCron(
    { $queryRawUnsafe: queryRawUnsafe, order: { findMany: jest.fn().mockResolvedValue([]) } } as any,
    { resumoDoCache: jest.fn().mockResolvedValue(new Map()), sincronizarLote: jest.fn() } as any,
  );
  const promover = jest.spyOn(cron as any, 'promoverEntregues').mockResolvedValue(undefined);
  jest.spyOn((cron as any).logger, 'log').mockImplementation(() => undefined);
  const envAntes = { ...process.env };
  Object.entries(opts.env ?? {}).forEach(([k, v]) => {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  });
  return { cron, queryRawUnsafe, promover, restaurar: () => { process.env = envAntes; } };
}

describe('RastreioSyncCron · reconciliarEntregues', () => {
  afterEach(() => jest.restoreAllMocks());

  it('promove o pedido cujo cache já diz entregue', async () => {
    const t = montar({ presos: [{ codigo: 'AD111111111BR' }, { codigo: 'AD222222222BR' }] });
    await (t.cron as any).reconciliarEntregues();
    expect(t.promover).toHaveBeenCalledWith(['AD111111111BR', 'AD222222222BR']);
    t.restaurar();
  });

  it('respeita o teto por ciclo (não fecha 255 pedidos de uma vez)', async () => {
    const t = montar({ presos: [{ codigo: 'AD1BR' }], env: { RASTREIO_RECONCILIA_LOTE: '7' } });
    await (t.cron as any).reconciliarEntregues();
    expect(t.queryRawUnsafe.mock.calls[0][1]).toBe(7);
    t.restaurar();
  });

  it('cai no default 40 quando o teto é lixo', async () => {
    const t = montar({ presos: [{ codigo: 'AD1BR' }], env: { RASTREIO_RECONCILIA_LOTE: 'abc' } });
    await (t.cron as any).reconciliarEntregues();
    expect(t.queryRawUnsafe.mock.calls[0][1]).toBe(40);
    t.restaurar();
  });

  it('RASTREIO_RECONCILIA=0 desliga sem nem consultar o banco', async () => {
    const t = montar({ presos: [{ codigo: 'AD1BR' }], env: { RASTREIO_RECONCILIA: '0' } });
    await (t.cron as any).reconciliarEntregues();
    expect(t.queryRawUnsafe).not.toHaveBeenCalled();
    expect(t.promover).not.toHaveBeenCalled();
    t.restaurar();
  });

  it('nada preso = nada promovido', async () => {
    const t = montar({ presos: [] });
    await (t.cron as any).reconciliarEntregues();
    expect(t.promover).not.toHaveBeenCalled();
    t.restaurar();
  });
});
