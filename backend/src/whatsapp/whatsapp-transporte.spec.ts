import { WhatsappService } from './whatsapp.service';

/**
 * POR ONDE O AVISO SAI (25/08/2026).
 *
 * O sistema tinha dois WhatsApps: a sessão Baileys do backend (pareada por QR)
 * e a instância do Evolution, que é o WhatsApp que a equipe usa no inbox. A
 * Baileys caiu em ~14/08 e ficou 11 dias fora sem ninguém ver — no dia 25 o
 * cron de trocas mandou 18 códigos de postagem **por e-mail** porque o
 * WhatsApp não respondia, enquanto o Evolution mandava 284 mensagens.
 *
 * Ordem do dono: aviso sai pelo Evolution, sessão local vira reserva. Estes
 * testes seguram as quatro coisas que não podem regredir:
 *
 *   1. com Evolution de pé, a sessão local não é tocada;
 *   2. Evolution recusando, a sessão local ainda salva o aviso;
 *   3. os dois fora → erro que DIZ os dois motivos (silêncio foi o defeito);
 *   4. `AVISOS_VIA_EVOLUTION=0` volta tudo como era, sem deploy.
 */
function montar(opts: {
  evoConfigurado?: boolean;
  evoFalha?: string;
  sockOk?: boolean;
  sockFalha?: string;
} = {}) {
  const enviarTexto = jest.fn(async () => {
    if (opts.evoFalha) throw new Error(opts.evoFalha);
    return {};
  });
  const sendMessage = jest.fn(async () => {
    if (opts.sockFalha) throw new Error(opts.sockFalha);
    return {};
  });
  const svc: any = Object.create(WhatsappService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.evo = {
    configurado: () => opts.evoConfigurado !== false,
    enviarTexto,
    instancia: 'lurds-abandono',
    instanciaConectada: jest.fn(async () => ({ ok: true, estado: 'open' })),
  };
  svc.sock = opts.sockOk ? { sendMessage } : null;
  svc.connectedAt = opts.sockOk ? new Date() : null;
  svc.ownNumber = opts.sockOk ? '5513999998888' : null;
  svc.lastQr = null;
  svc.evoConectado = false;
  svc.evoConferidoEm = null;
  return { svc: svc as WhatsappService, enviarTexto, sendMessage };
}

const TELEFONE = '13996256238';

describe('WhatsappService — por onde o aviso sai', () => {
  const antes = process.env.AVISOS_VIA_EVOLUTION;
  afterEach(() => {
    if (antes === undefined) delete process.env.AVISOS_VIA_EVOLUTION;
    else process.env.AVISOS_VIA_EVOLUTION = antes;
  });

  it('com Evolution de pé, manda por ele e nem encosta na sessão local', async () => {
    const { svc, enviarTexto, sendMessage } = montar({ sockOk: true });

    const r = await svc.sendText(TELEFONE, 'seu código de postagem é AP123');

    expect(r).toEqual({ ok: true });
    expect(enviarTexto).toHaveBeenCalledWith('5513996256238', 'seu código de postagem é AP123');
    expect(sendMessage).not.toHaveBeenCalled();
    // O envio que passou é a melhor prova de que o canal está de pé.
    expect(svc.getStatus().canal).toBe('evolution');
    expect(svc.getStatus().podeEnviar).toBe(true);
  });

  it('Evolution recusando, a sessão local ainda salva o aviso', async () => {
    const { svc, enviarTexto, sendMessage } = montar({ evoFalha: 'Evolution 500', sockOk: true });

    const r = await svc.sendText(TELEFONE, 'oi');

    expect(r).toEqual({ ok: true });
    expect(enviarTexto).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(svc.getStatus().canal).toBe('baileys');
  });

  it('os dois fora: o erro diz os DOIS motivos, não some calado', async () => {
    const { svc } = montar({ evoFalha: 'Evolution 401: apikey', sockOk: false });

    const r = await svc.sendText(TELEFONE, 'oi');

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Evolution 401/);
    expect(r.error).toMatch(/sess[ãa]o local/i);
    expect(svc.getStatus().podeEnviar).toBe(false);
    expect(svc.getStatus().canal).toBe('nenhum');
  });

  it('AVISOS_VIA_EVOLUTION=0 volta a mandar pela sessão local, sem deploy', async () => {
    process.env.AVISOS_VIA_EVOLUTION = '0';
    const { svc, enviarTexto, sendMessage } = montar({ sockOk: true });

    const r = await svc.sendText(TELEFONE, 'oi');

    expect(r).toEqual({ ok: true });
    expect(enviarTexto).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('número inválido nem tenta os canais', async () => {
    const { svc, enviarTexto, sendMessage } = montar({ sockOk: true });

    const r = await svc.sendText('abc', 'oi');

    expect(r.ok).toBe(false);
    expect(enviarTexto).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('`connected` continua sendo a sessão do QR — a tela de pareamento depende disso', async () => {
    const { svc } = montar({ sockOk: false });
    await svc.conferirEvolution();

    const s = svc.getStatus();
    expect(s.connected).toBe(false); // sessão local segue fora → a tela mostra o QR
    expect(s.canal).toBe('evolution'); // mas o aviso sai
    expect(s.podeEnviar).toBe(true);
    expect(s.evolution.instancia).toBe('lurds-abandono');
  });
});
