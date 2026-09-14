import { GoneException } from '@nestjs/common';
import { exigirWordpressLegado } from './wp-morto';
import { ProductsService } from '../products/products.service';

/**
 * A PORTA DO WOOCOMMERCE APAGADO FECHA COM MOTIVO (14/09/2026).
 *
 * O WordPress/WooCommerce foi apagado em 27/08/2026. O que sobrou no código
 * não "dava erro": `WC_URL` é o domínio do site NOVO, que responde **HTTP 403
 * pela Vercel** em `/wp-json` — e o bulk sync engolia isso
 * (`lastError` + `break`) e terminava marcando `finishedAt`, ou seja,
 * "sincronizou". Este teste trava as duas metades do conserto:
 *   1. a mensagem diz a verdade e não manda fazer o impossível;
 *   2. o botão "Sincronizar tudo" MORRE NA PORTA, sem marcar nada como feito.
 */
describe('Tranca do WooCommerce apagado', () => {
  const envAntes = process.env.KINGHOST_WP;
  afterEach(() => {
    if (envAntes === undefined) delete process.env.KINGHOST_WP;
    else process.env.KINGHOST_WP = envAntes;
  });

  it('410 Gone com o motivo e a data — e sem mandar consertar no WordPress', () => {
    delete process.env.KINGHOST_WP;
    let erro: any = null;
    try {
      exigirWordpressLegado('Sincronizar o estoque', 'o estoque vive no Postgres do Flow');
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(GoneException);
    // 410 e não 5xx de propósito: `lib/api.ts` do frontend marca a conexão como
    // OFFLINE em qualquer status >= 500, e a bolinha de saúde do sistema não
    // pode ficar vermelha por causa de uma tela de museu.
    expect(erro.getStatus()).toBe(410);
    const msg = String(erro.message);
    expect(msg).toContain('27/08/2026');
    expect(msg).toContain('403');
    expect(msg).toContain('Postgres do Flow');
    // Texto de tela não manda fazer o que não existe mais.
    expect(msg).not.toMatch(/reativ|plugin|wp-admin|painel do WordPress/i);
  });

  it('KINGHOST_WP=1 reabre (se um dia houver um WordPress novo pra apontar)', () => {
    process.env.KINGHOST_WP = '1';
    expect(() =>
      exigirWordpressLegado('Sincronizar o estoque', 'o estoque vive no Postgres do Flow'),
    ).not.toThrow();
  });

  it('"Sincronizar tudo" da tela /produtos nega na porta e NÃO marca sync como iniciado', () => {
    delete process.env.KINGHOST_WP;
    // Nenhuma dependência é usada: o `throw` é a primeira linha do método.
    const svc = new ProductsService(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    expect(() => svc.startBulkSync()).toThrow(GoneException);
    const estado = svc.getBulkSyncState();
    expect(estado.running).toBe(false);
    expect(estado.startedAt).toBeNull();
    expect(estado.finishedAt).toBeNull();
  });
});
