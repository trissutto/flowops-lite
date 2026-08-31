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
  const service = new PedidoEmailService(
    email as any, config as any, http as any, whats as any,
  );
  return { service, email, http, whats };
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
