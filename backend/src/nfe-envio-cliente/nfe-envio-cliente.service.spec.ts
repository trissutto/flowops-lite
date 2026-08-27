import { NfeEnvioClienteService } from './nfe-envio-cliente.service';

/**
 * O teste que importa aqui é a TRAVA: enquanto o dono não mandar ligar, nenhum
 * e-mail pode sair — nem por engano, nem por retry, nem por chamada manual.
 */
describe('NfeEnvioClienteService', () => {
  const NOTA_OK = {
    id: 'nfe-1', numero: 123, serie: '1', chave: '3526...44', status: 'authorized',
    tpAmb: '1', valorTotalCents: 15980, xMotivo: null,
  };
  const CARD = {
    id: 'pick-1', orderId: 'order-1', status: 'shipped',
    store: { code: '05', name: 'PIRACICABA' },
  };
  const PEDIDO = {
    id: 'order-1', wcOrderNumber: 'LP-000289', customerName: 'Jaqueline Cobucci',
    customerEmail: 'jaqueline@exemplo.com', pickOrders: [{ id: 'pick-1' }],
  };

  const montar = (over: { nota?: any; pedido?: any; jaEnviado?: any } = {}) => {
    const enviarEmail = jest.fn().mockResolvedValue(true);
    const criarRegistro = jest.fn().mockResolvedValue({});
    const prisma: any = {
      pickOrder: { findUnique: jest.fn().mockResolvedValue(CARD), findMany: jest.fn() },
      nfeDoc: { findFirst: jest.fn().mockResolvedValue('nota' in over ? over.nota : NOTA_OK) },
      order: { findUnique: jest.fn().mockResolvedValue('pedido' in over ? over.pedido : PEDIDO) },
      nfeEnvioCliente: {
        findFirst: jest.fn().mockResolvedValue(over.jaEnviado ?? null),
        create: criarRegistro,
        findMany: jest.fn(),
      },
    };
    const email: any = { send: enviarEmail };
    const danfe: any = {
      generateForDoc: jest.fn().mockResolvedValue({
        buffer: Buffer.from('%PDF-fake'), filename: 'danfe-123.pdf',
      }),
    };
    return {
      svc: new NfeEnvioClienteService(prisma, email, danfe),
      enviarEmail, criarRegistro, prisma, danfe,
    };
  };

  const semFlag = () => { delete process.env.NFE_ENVIO_CLIENTE; };
  const comFlag = () => { process.env.NFE_ENVIO_CLIENTE = '1'; };
  afterEach(() => { semFlag(); jest.clearAllMocks(); });

  describe('🚨 a trava', () => {
    it('DESLIGADO: não manda e-mail nenhum, e diz o que sairia', async () => {
      semFlag();
      const { svc, enviarEmail, criarRegistro } = montar();
      const r = await svc.enviarPorCard('pick-1');

      expect(enviarEmail).not.toHaveBeenCalled();   // ← o que não pode falhar
      expect(criarRegistro).not.toHaveBeenCalled();
      expect(r.resultado).toBe('simulado');
      expect(r.ok).toBe(true);
      expect(r.destino).toBe('jaqueline@exemplo.com');
      expect(r.pdfBytes).toBeGreaterThan(0); // o DANFE foi gerado de verdade
    });

    it('DESLIGADO com force: continua sem mandar', async () => {
      semFlag();
      const { svc, enviarEmail } = montar();
      const r = await svc.enviarPorCard('pick-1', { force: true });
      expect(enviarEmail).not.toHaveBeenCalled();
      expect(r.resultado).toBe('simulado');
    });

    it('flag com valor diferente de "1" não liga', async () => {
      process.env.NFE_ENVIO_CLIENTE = 'true';
      const { svc, enviarEmail } = montar();
      expect((await svc.enviarPorCard('pick-1')).resultado).toBe('simulado');
      expect(enviarEmail).not.toHaveBeenCalled();
    });

    it('LIGADO: manda com o PDF anexado e registra', async () => {
      comFlag();
      const { svc, enviarEmail, criarRegistro } = montar();
      const r = await svc.enviarPorCard('pick-1', { userId: 'user-9' });

      expect(r.resultado).toBe('enviado');
      const [to, assunto, html, texto, anexos] = enviarEmail.mock.calls[0];
      expect(to).toBe('jaqueline@exemplo.com');
      expect(assunto).toContain('LP-000289');
      expect(html).toContain('Jaqueline');
      expect(texto).toBeUndefined();
      expect(anexos[0].filename).toBe('danfe-123.pdf');
      expect(anexos[0].contentType).toBe('application/pdf');
      expect(criarRegistro).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'sent', enviadoPor: 'user-9' }) }),
      );
    });
  });

  describe('o que NÃO pode ir pra cliente', () => {
    it('nota rejeitada não vai', async () => {
      comFlag();
      const { svc, enviarEmail } = montar({ nota: { ...NOTA_OK, status: 'rejected', xMotivo: 'NCM inválido' } });
      const r = await svc.enviarPorCard('pick-1');
      expect(r.resultado).toBe('nota-invalida');
      expect(r.motivo).toContain('NCM inválido');
      expect(enviarEmail).not.toHaveBeenCalled();
    });

    it('nota de HOMOLOGAÇÃO não vai (SEFAZ não reconhece o DANFE)', async () => {
      comFlag();
      const { svc, enviarEmail } = montar({ nota: { ...NOTA_OK, tpAmb: '2' } });
      const r = await svc.enviarPorCard('pick-1');
      expect(r.resultado).toBe('nota-invalida');
      expect(r.motivo).toMatch(/homologa/i);
      expect(enviarEmail).not.toHaveBeenCalled();
    });

    it('envio sem nota emitida', async () => {
      comFlag();
      const { svc, enviarEmail } = montar({ nota: null });
      expect((await svc.enviarPorCard('pick-1')).resultado).toBe('sem-nota');
      expect(enviarEmail).not.toHaveBeenCalled();
    });

    it('cliente sem e-mail', async () => {
      comFlag();
      const { svc, enviarEmail } = montar({ pedido: { ...PEDIDO, customerEmail: null } });
      expect((await svc.enviarPorCard('pick-1')).resultado).toBe('sem-email');
      expect(enviarEmail).not.toHaveBeenCalled();
    });
  });

  describe('duplicata', () => {
    it('recusa reenvio pro mesmo destino', async () => {
      comFlag();
      const { svc, enviarEmail } = montar({ jaEnviado: { enviadoEm: new Date('2026-08-27T12:00:00Z') } });
      const r = await svc.enviarPorCard('pick-1');
      expect(r.resultado).toBe('ja-enviado');
      expect(enviarEmail).not.toHaveBeenCalled();
    });

    it('mas force reenvia de propósito', async () => {
      comFlag();
      const { svc, enviarEmail } = montar({ jaEnviado: { enviadoEm: new Date('2026-08-27T12:00:00Z') } });
      expect((await svc.enviarPorCard('pick-1', { force: true })).resultado).toBe('enviado');
      expect(enviarEmail).toHaveBeenCalled();
    });

    it('e-mail alternativo não é barrado pelo envio anterior', async () => {
      comFlag();
      const { svc, enviarEmail, prisma } = montar();
      await svc.enviarPorCard('pick-1', { emailOverride: 'outro@exemplo.com' });
      expect(prisma.nfeEnvioCliente.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ destino: 'outro@exemplo.com' }) }),
      );
      expect(enviarEmail.mock.calls[0][0]).toBe('outro@exemplo.com');
    });
  });

  describe('pedido dividido', () => {
    it('avisa que vem mais de uma nota, e de qual loja é esta', async () => {
      comFlag();
      const { svc, enviarEmail } = montar({
        pedido: { ...PEDIDO, pickOrders: [{ id: 'pick-1' }, { id: 'pick-2' }] },
      });
      await svc.enviarPorCard('pick-1');
      const html = enviarEmail.mock.calls[0][2];
      expect(html).toContain('2 volumes');
      expect(html).toContain('PIRACICABA');
    });

    it('pedido de uma loja só não fala em volumes', async () => {
      comFlag();
      const { svc, enviarEmail } = montar();
      await svc.enviarPorCard('pick-1');
      expect(enviarEmail.mock.calls[0][2]).not.toContain('volumes');
    });
  });

  it('falha do SMTP fica registrada como failed', async () => {
    comFlag();
    const { svc, criarRegistro } = montar();
    (svc as any).email.send = jest.fn().mockResolvedValue(false);
    const r = await svc.enviarPorCard('pick-1');
    expect(r.ok).toBe(false);
    expect(r.resultado).toBe('falha');
    expect(criarRegistro).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
