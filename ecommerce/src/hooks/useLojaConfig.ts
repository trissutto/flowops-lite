'use client';

import { useEffect, useState } from 'react';
import { FREE_SHIPPING_FROM } from '@/lib/commerce/frete';

/**
 * A RÉGUA COMERCIAL no navegador — frete grátis e retirada.
 *
 * Um fetch por sessão, guardado em módulo: a barra de frete grátis vive no
 * mini-carrinho E na página da sacola, e as duas montam/desmontam o tempo
 * todo. Sem o cache, cada abertura do carrinho seria uma requisição.
 *
 * Enquanto não responde (ou se o backend estiver fora), vale a constante
 * local. Nunca fica sem valor: barra sem número é pior que barra com o
 * número de ontem, e a config muda por decisão humana, não por minuto.
 */

export interface LojaConfig {
  freteGratis: { ativo: boolean; minimo: number; ufs: string | null };
  retirada: { prazoHoras: number; instrucoes: string | null };
  diasSeparacao: number;
  /**
   * QUEM COBRA O CARTÃO (16/09): decisão do backend (`SITE_GATEWAY`).
   * `pagbank` vem com a chave PÚBLICA da conta pro SDK criptografar o cartão
   * no navegador; `pagarme` é o caminho de sempre (token via `pk_`). Enquanto
   * a config não responde vale Pagar.me — nunca um formulário sem gateway.
   */
  pagamento: { cartao: 'pagbank' | 'pagarme'; pagbankPublicKey: string | null };
}

const PADRAO: LojaConfig = {
  freteGratis: { ativo: true, minimo: FREE_SHIPPING_FROM, ufs: null },
  retirada: { prazoHoras: 3, instrucoes: null },
  diasSeparacao: 2,
  pagamento: { cartao: 'pagarme', pagbankPublicKey: null },
};

let cache: LojaConfig | null = null;
let voando: Promise<LojaConfig> | null = null;

function carregar(): Promise<LojaConfig> {
  if (cache) return Promise.resolve(cache);
  if (voando) return voando;

  voando = fetch('/api/loja/config')
    .then((r) => r.json())
    .then((d) => {
      const cfg: LojaConfig = d?.ok
        ? {
            freteGratis: {
              ativo: !!d.freteGratis?.ativo,
              minimo: Number(d.freteGratis?.minimo) || 0,
              ufs: d.freteGratis?.ufs ?? null,
            },
            retirada: {
              prazoHoras: Number(d.retirada?.prazoHoras) || 3,
              instrucoes: d.retirada?.instrucoes ?? null,
            },
            diasSeparacao: Number(d.diasSeparacao) || 2,
            pagamento: {
              cartao:
                d.pagamento?.cartao?.gateway === 'pagbank' && typeof d.pagamento?.cartao?.pagbankPublicKey === 'string'
                  ? 'pagbank'
                  : 'pagarme',
              pagbankPublicKey:
                typeof d.pagamento?.cartao?.pagbankPublicKey === 'string' ? d.pagamento.cartao.pagbankPublicKey : null,
            },
          }
        : PADRAO;
      cache = cfg;
      return cfg;
    })
    .catch(() => PADRAO)
    .finally(() => {
      voando = null;
    });

  return voando;
}

export function useLojaConfig(): LojaConfig {
  const [cfg, setCfg] = useState<LojaConfig>(cache ?? PADRAO);

  useEffect(() => {
    let vivo = true;
    void carregar().then((c) => {
      if (vivo) setCfg(c);
    });
    return () => {
      vivo = false;
    };
  }, []);

  return cfg;
}
