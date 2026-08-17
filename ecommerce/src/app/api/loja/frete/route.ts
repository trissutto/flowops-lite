/**
 * POST /api/loja/frete — BFF da cotação.
 *
 * A regra de frete deixou de morar no site (bloco B da lista de lançamento):
 * tabela promocional, cotação do contrato, régua do frete grátis e dias de
 * separação são cadastro no FlowOps, editáveis na retaguarda sem deploy. Esta
 * rota só carrega o `x-loja-token` (que NUNCA pode ir pro navegador) e traduz
 * a resposta.
 *
 * Sem backend configurado ou fora do ar, devolve `ok:false` — quem chama
 * (`quoteShipping`) cai na tabela local, que continua existindo só pra isso.
 * Checkout parado por causa de cotação é pior que frete aproximado.
 */

import { NextResponse } from 'next/server';
import type { MotivoFalhaCotacao } from '@/lib/commerce/frete';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** O backend cria a cobrança; aqui é só leitura, então timeout curto. */
const TIMEOUT_MS = 9_000;

/**
 * POR QUE a cotação caiu na tabela local — vai no `motivo` da resposta.
 *
 * Até 17/08 tudo virava `{ ok:false, error:'indisponivel' }` e o console do
 * servidor era o único a saber se foi 429, timeout ou backend fora. Agora o
 * navegador recebe o motivo e decide: retentar (timeout — o backend termina a
 * cotação depois do abort e aquece o cache, a segunda vai rápida) ou NÃO
 * retentar (rate_limit — a janela é de 60s deslizantes, tentar de novo só
 * gasta o balde), além de mandar o motivo pra telemetria do funil.
 * O tipo mora em `lib/commerce/frete.ts`, ao lado de quem consome.
 */

/**
 * IP DA CLIENTE — a MESMA regra do `POST /api/checkout` (x-forwarded-for
 * primeiro, x-real-ip depois).
 *
 * Vai pro backend em `x-cliente-ip` porque o rate-limit de lá (20/min por
 * IP em `loja-orders.controller.ts`) lê esse header antes do x-forwarded-for.
 * Sem ele, o IP que o backend vê é o de SAÍDA DA VERCEL: a PDP, a sacola
 * (que recota a cada +/− de peça) e a etapa de entrega da loja INTEIRA
 * dividiam um balde só de 20 cotações por minuto — e a 21ª caía calada na
 * tabela local, sem promoção. O comentário do controller descrevia o
 * problema desde 10/08, mas o header nunca saiu do site (só a tubulação
 * existia em lib/api.ts e orders/store.ts, sem nenhum chamador).
 *
 * Vazio quando não há como saber (chamada local sem proxy) — aí o header
 * não vai e o backend cai no fallback dele, igual antes.
 */
function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0].trim() || req.headers.get('x-real-ip')?.trim() || '';
}

/**
 * ─────────────── COORDENADA DO CEP (pra retirada em loja) ───────────────
 *
 * NASCEU NO NAVEGADOR E FOI MOVIDA PRA CÁ. Dois motivos, os dois medidos:
 *
 * 1. COTA POR IP. A fonte gratuita corta em ~40 consultas por IP e devolve
 *    429 por uma janela longa. Saindo do navegador, quem paga a cota é o IP
 *    DA CLIENTE — e em 4G o CGNAT da operadora junta milhares de pessoas no
 *    mesmo IP. A regra dos 20 km ficaria desligada em silêncio pra boa parte
 *    do tráfego, e o teste no PC de casa nunca pegaria (um IP residencial
 *    sozinho não chega perto da cota).
 *
 * 2. CACHE. CEP → coordenada nunca muda. Aqui um Map transforma a cota em
 *    uma consulta por CEP distinto pra loja inteira.
 *
 * ⚠️ NUNCA PODE SEGURAR A COTAÇÃO. Requisição pendurada não rejeita — é a
 * mesma armadilha do Giga descrita no CLAUDE.md ("PENDURA, o .catch não
 * pega"). Por isso timeout no fetch E um Promise.race por cima: cinto e
 * suspensório. Sem coordenada a retirada cai na tabela de prefixos; sem
 * frete não tem venda.
 */
const GEO_TIMEOUT_MS = 1_200;
const geoCache = new Map<string, { lat: number; lng: number }>();

async function coordenadaDoCep(cep: string): Promise<{ lat: number; lng: number } | null> {
  const emCache = geoCache.get(cep);
  if (emCache) return emCache;

  const paraPonto = (lat: unknown, lng: unknown) => {
    const la = Number(lat);
    const ln = Number(lng);
    return Number.isFinite(la) && Number.isFinite(ln) ? { lat: la, lng: ln } : null;
  };

  /**
   * DUAS FONTES, NESTA ORDEM, E A ORDEM IMPORTA.
   *
   * A primeira devolve a coordenada da RUA. A segunda devolve o centroide do
   * MUNICÍPIO — em São Paulo ela dá o mesmo ponto pra Paulista, Anália
   * Franco e Berrini, e aí o raio não separa nada numa cidade de 50 km de
   * ponta a ponta. Por isso a precisa vem primeiro.
   *
   * Mas a precisa é gratuita com cota por IP: medido em 17/08, ela corta em
   * ~40 consultas e devolve 429 por uma janela longa. Quando isso acontece,
   * centroide de município ainda decide certo a maioria dos casos (Mongaguá
   * a 17 km de Itanhaém continua dentro) — e é MUITO melhor que cair na
   * tabela de prefixos, que não sabe distância nenhuma.
   */
  const buscar = async (): Promise<{ lat: number; lng: number } | null> => {
    try {
      const r = await fetch(`https://cep.awesomeapi.com.br/json/${cep}`, {
        signal: AbortSignal.timeout(GEO_TIMEOUT_MS),
        cache: 'no-store',
      });
      if (r.ok) {
        const d = (await r.json()) as { lat?: string; lng?: string };
        const p = paraPonto(d?.lat, d?.lng);
        if (p) return p;
      }
    } catch {
      /* cai pra segunda fonte */
    }

    try {
      const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, {
        signal: AbortSignal.timeout(GEO_TIMEOUT_MS),
        cache: 'no-store',
      });
      if (!r.ok) return null;
      const d = (await r.json()) as {
        location?: { coordinates?: { latitude?: string; longitude?: string } };
      };
      const c = d?.location?.coordinates;
      return paraPonto(c?.latitude, c?.longitude);
    } catch {
      return null;
    }
  };

  let ponto: { lat: number; lng: number } | null = null;
  try {
    ponto = await Promise.race([
      buscar(),
      // Duas fontes em série cabem aqui dentro; passou disso, a lista sai sem
      // distância e a retirada usa a tabela de prefixos.
      new Promise<null>((r) => setTimeout(() => r(null), GEO_TIMEOUT_MS * 2 + 300)),
    ]);
  } catch {
    ponto = null;
  }

  // Falha NÃO entra no cache: um 429 de agora não pode desligar a retirada
  // desse CEP pelo resto da vida do processo.
  if (ponto) geoCache.set(cep, ponto);
  return ponto;
}

export async function POST(req: Request) {
  let body: { cep?: unknown; subtotal?: unknown; pecas?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Requisição inválida.' }, { status: 400 });
  }

  const cep = String(body?.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) {
    return NextResponse.json({ ok: false, error: 'CEP inválido.' }, { status: 400 });
  }

  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
  const token = process.env.LOJA_ORDER_TOKEN ?? '';
  // Sempre status 200 com `ok:false`: quem chama (`fetchQuotes`) trata o
  // corpo, e um 5xx aqui viraria "erro de rede" no navegador — que é
  // exatamente o que a gente NÃO quer confundir com backend fora.
  const indisponivel = (motivo: MotivoFalhaCotacao) =>
    NextResponse.json({ ok: false, error: 'indisponivel', motivo }, { status: 200 });

  if (!baseUrl || !token) {
    console.warn('[frete] FLOWOPS_API_URL/LOJA_ORDER_TOKEN ausentes — site cai na tabela local');
    return indisponivel('config');
  }

  // Sai JUNTO com a cotação: ~0,2s contra ~1s, então não custa relógio.
  const pCoord = coordenadaDoCep(cep);

  const ip = clientIp(req);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/public/loja/frete`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-loja-token': token,
        // Balde do rate-limit POR CLIENTE, não por IP da Vercel (ver clientIp).
        ...(ip ? { 'x-cliente-ip': ip } : {}),
      },
      body: JSON.stringify({
        cep,
        pecas: Number(body?.pecas) || 1,
        subtotal: Number(body?.subtotal) || 0,
      }),
      signal: controller.signal,
      cache: 'no-store',
    });
    const dados = await res.json().catch(() => null);
    if (res.status === 429) {
      // O balde do backend estourou. Logado SEPARADO do "backend fora" de
      // propósito: são causas diferentes (carga × indisponibilidade) e a
      // correção também — este aqui é o que o x-cliente-ip acima resolve.
      console.warn(`[frete] backend devolveu 429 (rate-limit) pro IP ${ip || 'desconhecido'} — site cai na tabela local`);
      return indisponivel('rate_limit');
    }
    if (!res.ok || !dados?.ok) {
      console.warn(`[frete] backend respondeu ${res.status} sem cotação — site cai na tabela local`);
      return indisponivel('backend');
    }
    // `coord` é opcional por contrato: o site sabe viver sem ela.
    return NextResponse.json({ ...dados, coord: await pCoord }, { status: 200 });
  } catch (err) {
    const motivo: MotivoFalhaCotacao = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'rede';
    console.warn(`[frete] backend não respondeu (${motivo}) — site cai na tabela local`);
    return indisponivel(motivo);
  } finally {
    clearTimeout(timer);
  }
}
