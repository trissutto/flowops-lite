import { EscudoCheckoutService } from './escudo-checkout.service';

/**
 * Escudo anti-teste-de-cartão (28/08) — as regras que NÃO podem regredir:
 *
 *  - PIX passa SEMPRE (não existe teste de PIX; bloquear mataria a rota de
 *    fuga da cliente real durante um ataque).
 *  - País é fail-open: sem header (site antigo, local) NINGUÉM é bloqueado.
 *  - Velocity só arma com recusas de verdade — e, armado, cliente com pedido
 *    PAGO anterior continua comprando de cartão.
 *  - Bloqueio realimenta a janela: enquanto o bot insiste, o escudo não cai.
 */
describe('EscudoCheckoutService', () => {
  const JANELA_KEY = '__flowopsEscudoCheckoutJanela__';

  const prismaMock = (over: any = {}) => ({
    order: {
      // seed da janela (recusas recentes no banco) — zero por padrão
      count: jest.fn().mockResolvedValue(0),
      // cliente conhecida? — desconhecida por padrão
      findFirst: jest.fn().mockResolvedValue(null),
      ...(over.order || {}),
    },
    checkoutBloqueio: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      ...(over.checkoutBloqueio || {}),
    },
    appConfig: {
      findUnique: jest.fn().mockResolvedValue(null), // sem config = modo auto
      upsert: jest.fn().mockResolvedValue({}),
      ...(over.appConfig || {}),
    },
  });

  const cartao = (extra: any = {}) => ({
    metodo: 'card',
    ip: '45.10.20.30',
    nome: 'Alice Souza',
    email: 'alice.souza123@gmail.com',
    cpf: '12345678909',
    fone: '13996000000',
    total: 95.35,
    ...extra,
  });

  const ENVS = [
    'CHECKOUT_ESCUDO',
    'CHECKOUT_CARTAO_SO_BRASIL',
    'CHECKOUT_ESCUDO_RECUSAS',
    'CHECKOUT_ESCUDO_JANELA_MIN',
    'CHECKOUT_BLOQUEIO_IPS',
  ];
  const envAntes: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENVS) {
      envAntes[k] = process.env[k];
      delete process.env[k];
    }
    // Janela em globalThis sobrevive entre instâncias DE PROPÓSITO (deploy/hot
    // reload) — nos testes cada caso começa do zero.
    (globalThis as any)[JANELA_KEY] = undefined;
  });

  afterEach(() => {
    for (const k of ENVS) {
      if (envAntes[k] === undefined) delete process.env[k];
      else process.env[k] = envAntes[k];
    }
  });

  it('PIX passa sempre — até com o escudo armado na mão', async () => {
    const prisma = prismaMock({
      appConfig: { findUnique: jest.fn().mockResolvedValue({ valueJson: '{"modo":"on"}' }) },
    });
    const svc = new EscudoCheckoutService(prisma as any);
    expect(await svc.avaliar(cartao({ metodo: 'pix', pais: 'US' }))).toBeNull();
    expect(prisma.checkoutBloqueio.create).not.toHaveBeenCalled();
  });

  it('cartão de IP estrangeiro bloqueia; sem header de país passa (fail-open)', async () => {
    const prisma = prismaMock();
    const svc = new EscudoCheckoutService(prisma as any);

    const bloqueio = await svc.avaliar(cartao({ pais: 'VN' }));
    expect(bloqueio).not.toBeNull();
    expect(bloqueio!.code).toBe('payment_unavailable');
    expect(prisma.checkoutBloqueio.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ motivo: 'pais' }) }),
    );

    expect(await svc.avaliar(cartao({ pais: '' }))).toBeNull();
    expect(await svc.avaliar(cartao({ pais: 'BR' }))).toBeNull();
  });

  it('CHECKOUT_CARTAO_SO_BRASIL=0 desliga o corte por país', async () => {
    process.env.CHECKOUT_CARTAO_SO_BRASIL = '0';
    const svc = new EscudoCheckoutService(prismaMock() as any);
    expect(await svc.avaliar(cartao({ pais: 'US' }))).toBeNull();
  });

  it('IP na lista CHECKOUT_BLOQUEIO_IPS bloqueia por prefixo', async () => {
    process.env.CHECKOUT_BLOQUEIO_IPS = '200.219.50.,10.0.0.1';
    const prisma = prismaMock();
    const svc = new EscudoCheckoutService(prisma as any);
    const b = await svc.avaliar(cartao({ ip: '200.219.50.140' }));
    expect(b).not.toBeNull();
    expect(prisma.checkoutBloqueio.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ motivo: 'ip_bloqueado' }) }),
    );
    expect(await svc.avaliar(cartao({ ip: '200.219.51.1' }))).toBeNull();
  });

  it('velocity arma com as recusas e, armado, só cliente conhecida compra de cartão', async () => {
    const prisma = prismaMock();
    const svc = new EscudoCheckoutService(prisma as any);

    // 4 recusas: abaixo do limiar (5) — cliente nova ainda passa
    for (let i = 0; i < 4; i++) svc.registrarRecusa();
    expect(await svc.avaliar(cartao())).toBeNull();

    // 5ª recusa arma o escudo — cliente DESCONHECIDA é barrada...
    svc.registrarRecusa();
    const b = await svc.avaliar(cartao());
    expect(b).not.toBeNull();
    expect(prisma.checkoutBloqueio.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ motivo: 'escudo' }) }),
    );

    // ...e cliente com pedido PAGO anterior continua comprando
    prisma.order.findFirst.mockResolvedValue({ id: 'ord-1' });
    expect(await svc.avaliar(cartao())).toBeNull();
  });

  it('bloqueio realimenta a janela (o escudo não cai enquanto o bot insiste)', async () => {
    const prisma = prismaMock();
    const svc = new EscudoCheckoutService(prisma as any);
    for (let i = 0; i < 5; i++) svc.registrarRecusa();
    await svc.avaliar(cartao()); // bloqueado → +1 evento
    const st = await svc.status();
    expect(st.eventosNaJanela).toBe(6);
    expect(st.armado).toBe(true);
  });

  it('seed do banco: reiniciar o backend no meio do ataque não desarma', async () => {
    const prisma = prismaMock({ order: { count: jest.fn().mockResolvedValue(9), findFirst: jest.fn().mockResolvedValue(null) } });
    const svc = new EscudoCheckoutService(prisma as any);
    // janela recém-criada (deploy) — o primeiro avaliar já vê as 9 recusas do banco
    expect(await svc.avaliar(cartao())).not.toBeNull();
  });

  it("modo 'off' desarma o velocity; CHECKOUT_ESCUDO=0 desliga tudo", async () => {
    const prismaOff = prismaMock({
      appConfig: { findUnique: jest.fn().mockResolvedValue({ valueJson: '{"modo":"off"}' }) },
    });
    const svcOff = new EscudoCheckoutService(prismaOff as any);
    for (let i = 0; i < 10; i++) svcOff.registrarRecusa();
    expect(await svcOff.avaliar(cartao())).toBeNull();
    // camada de país continua mesmo com modo off
    expect(await svcOff.avaliar(cartao({ pais: 'US' }))).not.toBeNull();

    process.env.CHECKOUT_ESCUDO = '0';
    const svcMorto = new EscudoCheckoutService(prismaMock() as any);
    expect(await svcMorto.avaliar(cartao({ pais: 'US', ip: '200.219.50.140' }))).toBeNull();
  });
});
