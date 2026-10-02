import * as bcrypt from 'bcrypt';
import { CustomerPasswordResetService } from './customer-password-reset.service';

/**
 * O "esqueci a senha" respondia "código enviado" pra tudo (02/10/2026): CPF
 * sem conta, conta sem contato, WhatsApp fora. Estes testes travam a resposta
 * honesta — e o piso de senha igual ao do cadastro.
 */
function montar(opts: {
  conta?: { id: string; cpf: string; name: string | null; phone: string | null; email: string | null } | null;
  ultimoToken?: { createdAt: Date } | null;
  zap?: { ok: boolean; error?: string };
  emailOk?: boolean;
}) {
  const prisma = {
    customerAccount: {
      findUnique: jest.fn().mockResolvedValue(opts.conta ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
    customerPasswordResetToken: {
      findFirst: jest.fn().mockResolvedValue(opts.ultimoToken ?? null),
      create: jest.fn().mockResolvedValue({ id: 'tok-1' }),
      delete: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const whatsapp = { sendText: jest.fn().mockResolvedValue(opts.zap ?? { ok: true }) };
  const email = { send: jest.fn().mockResolvedValue(opts.emailOk ?? true) };
  const svc = new CustomerPasswordResetService(prisma as any, whatsapp as any, email as any);
  (svc as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { svc, prisma, whatsapp, email };
}

const CPF = '12345678901';
const conta = { id: 'acc-1', cpf: CPF, name: 'Maria Silva', phone: '(13) 99999-1234', email: 'maria.silva@gmail.com' };

describe('pedido do código de senha', () => {
  it('CPF sem conta: diz que não tem conta e não manda nada', async () => {
    const { svc, whatsapp, email, prisma } = montar({ conta: null });
    expect(await svc.requestReset(CPF)).toEqual({ sent: false, motivo: 'sem_conta' });
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
    expect(prisma.customerPasswordResetToken.create).not.toHaveBeenCalled();
  });

  it('conta sem WhatsApp nem e-mail: sem_contato, nenhum token criado', async () => {
    const { svc, prisma } = montar({ conta: { ...conta, phone: null, email: null } });
    expect(await svc.requestReset(CPF)).toEqual({ sent: false, motivo: 'sem_contato' });
    expect(prisma.customerPasswordResetToken.create).not.toHaveBeenCalled();
  });

  it('manda pelos DOIS canais e devolve os dois destinos mascarados', async () => {
    const { svc, whatsapp, email } = montar({ conta });
    const r = await svc.requestReset(CPF);
    expect(r).toEqual({ sent: true, phoneMasked: '****-1234', emailMasked: 'ma***@gmail.com' });
    expect(whatsapp.sendText).toHaveBeenCalledWith('13999991234', expect.stringMatching(/\*\d{6}\*/));
    expect(email.send).toHaveBeenCalledWith('maria.silva@gmail.com', expect.any(String), expect.any(String), expect.any(String));
  });

  it('WhatsApp fora, e-mail saiu: enviado, e só o e-mail aparece como destino', async () => {
    const { svc, prisma } = montar({ conta, zap: { ok: false, error: 'desconectado' } });
    expect(await svc.requestReset(CPF)).toEqual({ sent: true, emailMasked: 'ma***@gmail.com' });
    expect(prisma.customerPasswordResetToken.delete).not.toHaveBeenCalled();
  });

  it('nenhum canal entregou: falha_envio e o token é apagado (não trava o próximo pedido)', async () => {
    const { svc, prisma } = montar({ conta, zap: { ok: false, error: 'desconectado' }, emailOk: false });
    expect(await svc.requestReset(CPF)).toEqual({ sent: false, motivo: 'falha_envio' });
    expect(prisma.customerPasswordResetToken.delete).toHaveBeenCalledWith({ where: { id: 'tok-1' } });
  });

  it('WhatsApp que LANÇA não derruba o pedido: vale o e-mail', async () => {
    const { svc, whatsapp } = montar({ conta });
    whatsapp.sendText.mockRejectedValue(new Error('timeout'));
    expect(await svc.requestReset(CPF)).toEqual({ sent: true, emailMasked: 'ma***@gmail.com' });
  });

  it('segundo pedido em menos de 60s: aguarde, sem mandar de novo', async () => {
    const { svc, whatsapp, email } = montar({ conta, ultimoToken: { createdAt: new Date(Date.now() - 10_000) } });
    const r = await svc.requestReset(CPF);
    expect(r).toMatchObject({ sent: true, motivo: 'aguarde', phoneMasked: '****-1234' });
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });
});

describe('troca da senha com o código', () => {
  it('senha de 4 dígitos passa — mesmo piso do cadastro e do login', async () => {
    const { svc, prisma } = montar({ conta });
    prisma.customerPasswordResetToken.findFirst.mockResolvedValue({
      id: 'tok-1', code: await bcrypt.hash('123456', 4), attempts: 0,
    });
    await expect(svc.confirmReset(CPF, '123456', '1234')).resolves.toEqual({ success: true });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('senha de 3 dígitos: a recusa fala da SENHA, não do código', async () => {
    const { svc } = montar({ conta });
    await expect(svc.confirmReset(CPF, '123456', '123')).rejects.toThrow(/senha precisa ter ao menos 4/i);
  });

  it('código errado: conta a tentativa e diz quantas restam', async () => {
    const { svc, prisma } = montar({ conta });
    prisma.customerPasswordResetToken.findFirst.mockResolvedValue({
      id: 'tok-1', code: await bcrypt.hash('123456', 4), attempts: 1,
    });
    await expect(svc.confirmReset(CPF, '000000', '1234')).rejects.toThrow('Restam 1 tentativa');
    expect(prisma.customerPasswordResetToken.update).toHaveBeenCalledWith({
      where: { id: 'tok-1' }, data: { attempts: { increment: 1 } },
    });
  });

  it('última tentativa errada: manda pedir código novo', async () => {
    const { svc, prisma } = montar({ conta });
    prisma.customerPasswordResetToken.findFirst.mockResolvedValue({
      id: 'tok-1', code: await bcrypt.hash('123456', 4), attempts: 2,
    });
    await expect(svc.confirmReset(CPF, '000000', '1234')).rejects.toThrow(/Peça um código novo/);
  });
});
