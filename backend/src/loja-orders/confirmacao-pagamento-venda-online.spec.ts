/**
 * CONFIRMAÇÃO DE PAGAMENTO — quem recebe e quem NÃO recebe (31/08, dono).
 *
 * Venda online lançada pela vendedora (`source: 'pdv_online'`): a cliente NÃO
 * recebe o "recebemos o seu pagamento" automático. Quem pegou o dinheiro foi a
 * vendedora, dentro de uma conversa que ela já está tendo no WhatsApp da loja —
 * o automático chegava depois dela, por outro número, e quando errava a leitura
 * errava na frente de quem estava atendendo (ON-000049, 19/08: confirmação às
 * 17:26, "Nao paguei ainda" às 17:27).
 *
 * Pedido do SITE (`source: 'ecommerce'`): nada muda. Lá não existe vendedora do
 * outro lado, e a confirmação automática é a única coisa que a cliente recebe.
 */
import { PedidoEmailService } from './pedido-email.service';

const ENV = {
  N8N_PEDIDO_WEBHOOK_URL: 'https://n8n.exemplo/webhook/pedido',
  PEDIDO_EMAIL_PROPRIO: '1', // e-mail próprio LIGADO — pra provar que ele também é barrado
  WHATS_PEDIDO_DIRETO: '1',
};

function montar() {
  const email = { send: jest.fn().mockResolvedValue(true) };
  const http = { post: jest.fn().mockReturnValue({ subscribe: () => undefined, then: undefined }) };
  const whats = { sendText: jest.fn().mockResolvedValue({ ok: true }) };
  const config = { get: (k: string) => (ENV as any)[k] };
  // Registro de aviso enviado (`avisos_enviados`) — o que responde depois
  // "a cliente recebeu?".
  const criarAviso = jest.fn().mockResolvedValue({});
  const prisma = { avisoEnviado: { create: criarAviso } };
  const service = new PedidoEmailService(
    email as any, config as any, http as any, whats as any, prisma as any,
  );
  return { service, email, http, whats, criarAviso };
}

const pedido = (over: any) => ({
  wcOrderNumber: 'ON-000237',
  customerName: 'Alyne de Oliveira Ferro',
  customerEmail: 'cliente@exemplo.com',
  customerPhone: '11999998888',
  totalAmount: 228.07,
  items: [{ ref: 'BMM-100', cor: 'VINHO', tamanho: '54', quantity: 1, unitPrice: 69.9 }],
  ...over,
});

describe('confirmação de pagamento — venda online da vendedora × pedido do site', () => {
  it('venda online (pdv_online) NÃO dispara confirmação por nenhum canal', async () => {
    const { service, email, http } = montar();

    await service.aoConfirmarPagamento(pedido({ source: 'pdv_online' }));

    // n8n = o WhatsApp de "recebemos o seu pagamento"
    expect(http.post).not.toHaveBeenCalled();
    // e-mail próprio, mesmo com PEDIDO_EMAIL_PROPRIO=1
    expect(email.send).not.toHaveBeenCalled();
  });

  it('pedido do site (ecommerce) continua confirmando normalmente', async () => {
    const { service, email, http } = montar();

    await service.aoConfirmarPagamento(pedido({ source: 'ecommerce' }));

    expect(http.post).toHaveBeenCalled();
    expect(email.send).toHaveBeenCalled();
    const [, assunto, titulo] = email.send.mock.calls[0];
    expect(`${assunto} ${titulo}`).toContain('Pagamento confirmado');
  });

  it('pedido sem `source` (legado) não é confundido com venda online', async () => {
    const { service, http } = montar();

    await service.aoConfirmarPagamento(pedido({ source: null }));

    expect(http.post).toHaveBeenCalled();
  });

  it('a venda online não fica muda: manda o registro do pedido, sem afirmar pagamento', async () => {
    const { service, whats, http } = montar();

    await service.aoRegistrarPedidoOnline(pedido({ source: 'pdv_online' }));

    expect(whats.sendText).toHaveBeenCalledTimes(1);
    const texto: string = whats.sendText.mock.calls[0][1];
    expect(texto).toContain('ON-000237');
    expect(texto).toContain('BMM-100');
    expect(texto).toMatch(/registrado/i);
    // Não pode afirmar que o dinheiro entrou.
    expect(texto).not.toMatch(/pagamento|pago|recebemos o seu/i);
    // E NUNCA pelo n8n: lá o status 'processing' vira "pagamento confirmado".
    expect(http.post).not.toHaveBeenCalled();
  });
});

/**
 * REGISTRO DO QUE SAIU (31/08) — ver o model `AvisoEnviado`.
 *
 * O caso Rosana terminou em "não dá pra saber se ela recebeu", porque o
 * sistema disparava WhatsApp e e-mail sem guardar nada. Estes testes prendem
 * as duas metades: o que sai fica registrado, e o que NÃO sai por regra fica
 * registrado também — silêncio combinado e silêncio por defeito são idênticos
 * vistos de fora, e quem investiga precisa distinguir.
 */
describe('registro de avisos enviados', () => {
  const dados = (m: jest.Mock, i = 0) => m.mock.calls[i][0].data;

  it('confirmação do site registra o canal, o destino e o pedido', async () => {
    const { service, criarAviso } = montar();

    await service.aoConfirmarPagamento(pedido({ source: 'ecommerce', id: 'uuid-1' }));

    // O disparo pro n8n é fire-and-forget de propósito (o dinheiro já entrou;
    // aviso não pode segurar o ack do webhook), então o registro DELE não tem
    // ordem garantida dentro do teste. O do e-mail é aguardado — e é ele que
    // prova que a saída vira linha no registro.
    const email = criarAviso.mock.calls
      .map((c) => c[0].data)
      .find((d: any) => d.canal === 'email');
    expect(email).toMatchObject({
      evento: 'pagamento_confirmado',
      wcOrderNumber: 'ON-000237',
      orderId: 'uuid-1',
      destino: 'cliente@exemplo.com',
      ok: true,
    });
  });

  it('a retenção da venda online também vira registro, com o motivo', async () => {
    const { service, criarAviso } = montar();

    await service.aoConfirmarPagamento(pedido({ source: 'pdv_online' }));

    expect(criarAviso).toHaveBeenCalledTimes(1);
    expect(dados(criarAviso)).toMatchObject({
      evento: 'pagamento_confirmado',
      canal: 'regra',
      ok: false,
    });
    expect(dados(criarAviso).erro).toContain('venda online da vendedora');
  });

  it('falha do canal fica registrada com o erro — é o que responde "por que não chegou"', async () => {
    const { service, criarAviso, whats } = montar();
    whats.sendText.mockResolvedValue({ ok: false, error: 'instância desconectada' });

    await service.aoRegistrarPedidoOnline(pedido({ source: 'pdv_online' }));

    const reg = dados(criarAviso);
    expect(reg).toMatchObject({ evento: 'pedido_online_registro', canal: 'whatsapp', ok: false });
    expect(reg.erro).toBe('instância desconectada');
  });

  it('banco fora NÃO derruba o envio — o log é observação, nunca dono', async () => {
    const { service, criarAviso, whats } = montar();
    criarAviso.mockRejectedValue(new Error('connection refused'));

    await expect(
      service.aoRegistrarPedidoOnline(pedido({ source: 'pdv_online' })),
    ).resolves.toBeUndefined();

    // A mensagem saiu mesmo com o registro falhando.
    expect(whats.sendText).toHaveBeenCalledTimes(1);
  });
});
