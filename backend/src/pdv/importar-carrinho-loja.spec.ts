import { PdvController } from './pdv.controller';

/**
 * "Fechar esta venda no PDV" morria em `400 storeCode obrigatório` quando quem
 * clicava era a matriz (24/08/2026).
 *
 * O botão existe nos dois lados: no PDV da loja-canal (role=store, a loja vem do
 * token) e na retaguarda, em `/separacao?tab=carrinhos` — onde o admin **não tem
 * loja no token** e ninguém mandava `storeCode`. A operadora fechava a venda no
 * WhatsApp e ela não entrava no sistema, que é o buraco que este botão existe
 * pra tapar.
 */
describe('PdvController.importarCarrinho — de qual loja é a venda', () => {
  const fazController = () => {
    const importarCarrinho = jest.fn().mockResolvedValue({ saleId: 's1', storeCode: '13' });
    // Sem passar pelo construtor: ele pede uma dúzia de serviços que este teste
    // não usa, e o que está sendo testado é a decisão da LOJA, não a injeção.
    const ctrl = Object.create(PdvController.prototype) as PdvController;
    (ctrl as any).svc = { importarCarrinho };
    return { ctrl, importarCarrinho };
  };

  const req = (user: any) => ({ user });

  it('admin da matriz sem loja no token cai na loja-canal SITE (13)', async () => {
    const { ctrl, importarCarrinho } = fazController();
    await ctrl.importarCarrinho(req({ role: 'admin', id: 'u1', name: 'Matriz' }), {
      recoveryId: 'rec-1',
    });
    expect(importarCarrinho.mock.calls[0][0]).toMatchObject({ storeCode: '13', recoveryId: 'rec-1' });
  });

  it('vendedora usa a loja DELA, mesmo se o corpo mandar outra', async () => {
    const { ctrl, importarCarrinho } = fazController();
    await ctrl.importarCarrinho(req({ role: 'store', storeCode: '07', id: 'u2' }), {
      wcOrderId: 950000123,
      storeCode: '13',
    });
    expect(importarCarrinho.mock.calls[0][0].storeCode).toBe('07');
  });

  it('admin que pede loja específica continua sendo obedecido', async () => {
    const { ctrl, importarCarrinho } = fazController();
    await ctrl.importarCarrinho(req({ role: 'admin', id: 'u1' }), {
      wcOrderId: 950000123,
      storeCode: '17',
    });
    expect(importarCarrinho.mock.calls[0][0].storeCode).toBe('17');
  });

  it('quem não é admin nem loja não importa carrinho nenhum', async () => {
    const { ctrl, importarCarrinho } = fazController();
    expect(() => ctrl.importarCarrinho(req({ role: 'franquias' }), { recoveryId: 'rec-1' })).toThrow();
    expect(importarCarrinho).not.toHaveBeenCalled();
  });
});
