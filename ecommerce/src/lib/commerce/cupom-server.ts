import 'server-only';

import {
  applyCoupon,
  MENSAGEM_NOMINAL_CPF_DIFERENTE,
  MENSAGEM_NOMINAL_SEM_CPF,
  type CouponRule,
} from './cupom';
import type { CouponResult } from '@/types/checkout';

/**
 * VALIDAÇÃO DE CUPOM NO SERVIDOR — chamada pelo `POST /api/checkout` (o gate
 * do pedido) e pelo `POST /api/loja/cupom` (o BFF que a sacola consulta).
 *
 * Mesmo desenho do `frete-server.ts`: a chamada é direta ao FlowOps com o
 * `x-loja-token` que nunca sai daqui, e backend fora do ar NÃO trava a
 * compra — cai na tabela local (campanhas), porque quem cobra é o backend e
 * ele reconfere o cupom quando o pedido nasce (`CupomService.aplicar` no
 * `criarPedido`). O que a queda custa é só o código que EXISTE apenas em
 * `site_cupons` (vale-troca, campanha da retaguarda): esse responde "não
 * encontramos" até a rede voltar.
 *
 * Por que existir em vez de a tabela local bastar: cupom criado na
 * retaguarda e VALE-TROCA nominal (o crédito da cliente, preso por CPF)
 * moram em `site_cupons` — a lista local nem tem como representá-los. Era o
 * buraco em que os vales do site velho caíam (01/09/2026).
 */

const TIMEOUT_MS = 6_000;

/** O resultado + a regra que permite ao client recalcular localmente. */
export type CupomValidado = CouponResult & { rule?: CouponRule };

interface RespostaBackend {
  ok?: boolean;
  resultado?: {
    ok?: boolean;
    code?: string;
    desconto?: number;
    tipo?: 'percent' | 'fixed' | 'shipping';
    mensagem?: string;
    motivo?: 'nominal_sem_cpf' | 'nominal_cpf_diferente';
    regra?: {
      tipo?: 'percent' | 'fixed' | 'shipping';
      valor?: number;
      minSubtotal?: number | null;
      fimEm?: string | null;
      label?: string;
      /** true = vale-troca nominal; o client não pode recalcular sem CPF. */
      nominal?: boolean;
    };
  };
}

export async function validarCupomServer(input: {
  code: string;
  subtotal: number;
  cpf?: string;
  /** IP da cliente — balde do rate-limit por pessoa, não por IP da Vercel. */
  clientIp?: string;
}): Promise<CupomValidado> {
  const code = String(input.code || '').trim().toUpperCase();
  const local = () => applyCoupon(code, input.subtotal);

  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
  const token = process.env.LOJA_ORDER_TOKEN ?? '';
  if (!baseUrl || !token) return local();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/public/loja/cupom`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-loja-token': token,
        ...(input.clientIp ? { 'x-cliente-ip': input.clientIp } : {}),
      },
      body: JSON.stringify({
        code,
        subtotal: input.subtotal,
        ...(input.cpf ? { cpf: String(input.cpf).replace(/\D/g, '') } : {}),
      }),
      signal: controller.signal,
      cache: 'no-store',
    });
    const dados = (await res.json().catch(() => null)) as RespostaBackend | null;
    const r = dados?.resultado;
    if (!dados?.ok || !r || typeof r.ok !== 'boolean') {
      console.warn(
        `[cupom] backend indisponível (${res.status === 429 ? 'rate-limit' : `status ${res.status}`}) — validando pela tabela local`,
      );
      return local();
    }
    return {
      ok: r.ok,
      code: String(r.code || code),
      discount: Number(r.desconto) || 0,
      // As frases do vale nominal são as do SITE (mesma régua do recálculo
      // local): o backend manda o `motivo`, o texto que a cliente lê é um só.
      message:
        r.motivo === 'nominal_cpf_diferente'
          ? MENSAGEM_NOMINAL_CPF_DIFERENTE
          : r.motivo === 'nominal_sem_cpf'
            ? MENSAGEM_NOMINAL_SEM_CPF
            : String(r.mensagem || ''),
      ...(r.tipo ? { kind: r.tipo } : {}),
      ...(r.motivo ? { reason: r.motivo } : {}),
      // `motivo` só existe na recusa nominal, e `regra.nominal` só no sucesso:
      // juntos dizem "isto é um vale-troca" nos dois desfechos.
      ...(r.motivo || r.regra?.nominal ? { nominal: true } : {}),
      ...(r.ok && r.regra?.tipo
        ? {
            rule: {
              code: String(r.code || code),
              kind: r.regra.tipo,
              value: Number(r.regra.valor) || 0,
              ...(r.regra.minSubtotal != null ? { minSubtotal: Number(r.regra.minSubtotal) } : {}),
              ...(r.regra.fimEm ? { expiresAt: r.regra.fimEm } : {}),
              label: String(r.regra.label || r.code || code),
              ...(r.regra.nominal ? { nominal: true } : {}),
            } satisfies CouponRule,
          }
        : {}),
    };
  } catch (err) {
    const motivo = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'rede';
    console.warn(`[cupom] backend não respondeu (${motivo}) — validando pela tabela local`);
    return local();
  } finally {
    clearTimeout(timer);
  }
}
