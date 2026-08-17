import 'server-only';

import { stores } from '@/data/stores';
import { findQuote } from './frete';
import type { ShippingQuote } from '@/types/checkout';

/**
 * COTAÇÃO NO SERVIDOR — usada pelo `POST /api/checkout` pra resolver qual
 * opção de entrega a cliente escolheu.
 *
 * Por que não reusar o `fetchQuotes` do client: aquele bate em `/api/loja/frete`
 * com URL relativa, que não existe no contexto do servidor. Aqui a chamada é
 * direta ao FlowOps, com o token que nunca sai daqui.
 *
 * Por que continuar resolvendo no BFF se o backend reconfere: barreira dupla
 * é barata e pega coisa diferente. Aqui a gente descobre CEDO que a opção não
 * existe (e devolve uma frase elegante em vez de deixar o pedido nascer pra
 * morrer na cobrança). O valor que VALE é sempre o do backend.
 *
 * Backend fora do ar → cai na tabela local, igual à tela. Checkout parado por
 * causa de cotação é pior que frete aproximado, e o backend reprecifica tudo
 * antes de cobrar de qualquer jeito.
 */

const TIMEOUT_MS = 9_000;

export async function resolverFrete(input: {
  cep: string;
  subtotal: number;
  pecas: number;
  quoteId: string;
}): Promise<ShippingQuote | undefined> {
  const cep = String(input.cep || '').replace(/\D/g, '');

  /**
   * Retirada não é cotação: a loja sai da tabela de lojas do próprio site.
   *
   * ⚠️ ACEITA QUALQUER LOJA DA REDE, DE PROPÓSITO — não reaplica o raio de
   * 20 km. O raio decide o que a gente OFERECE; recusar aqui pelo mesmo
   * critério transformaria uma regra de vitrine em motivo de pedido
   * rejeitado. As duas pontas usam fontes diferentes (a tela tem a
   * coordenada do CEP, o servidor não), então elas VÃO discordar em algum
   * caso de borda — e discordar aqui custa a venda.
   *
   * O que se perde aceitando: nada. Retirada é R$ 0 em qualquer loja, e
   * quem escolhe uma longe só vai ter que dirigir mais.
   */
  if (input.quoteId.startsWith('retirada-')) {
    const slug = input.quoteId.slice('retirada-'.length);
    const loja = stores.find((s) => s.slug === slug);
    if (!loja) return undefined;
    return {
      id: input.quoteId,
      kind: 'retirada',
      label: `Retirar na loja ${loja.unit}`,
      price: 0,
      readyInHours: 3,
      storeSlug: loja.slug,
      storeLabel: `${loja.unit} · ${loja.city}/${loja.uf}`,
    };
  }

  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
  const token = process.env.LOJA_ORDER_TOKEN ?? '';
  if (!baseUrl || !token) return findQuote(cep, input.subtotal, input.quoteId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/public/loja/frete`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-loja-token': token,
      },
      body: JSON.stringify({ cep, subtotal: input.subtotal, pecas: input.pecas }),
      signal: controller.signal,
      cache: 'no-store',
    });
    const dados = await res.json().catch(() => null);
    if (!dados?.ok || !Array.isArray(dados.opcoes)) {
      return findQuote(cep, input.subtotal, input.quoteId);
    }
    type OpcaoApi = {
      id?: string | number; kind?: string; label?: string;
      price?: number | string; etaDays?: { min: number; max: number };
    };
    const achada = dados.opcoes.find((o: OpcaoApi) => String(o.id) === input.quoteId);
    if (!achada) return undefined;
    return {
      id: String(achada.id),
      kind: achada.kind === 'expressa' ? 'expressa' : 'correios',
      label: String(achada.label),
      price: Number(achada.price) || 0,
      etaDays: achada.etaDays,
    };
  } catch {
    return findQuote(cep, input.subtotal, input.quoteId);
  } finally {
    clearTimeout(timer);
  }
}
