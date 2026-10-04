/**
 * POST /api/csp-report — destino do `report-uri` da CSP em modo relatório.
 *
 * A política nasce como `Content-Security-Policy-Report-Only` (ver
 * `next.config.ts`): nada é bloqueado, o navegador só avisa aqui o que TERIA
 * sido bloqueado. É este log que diz quando dá pra enforçar sem derrubar
 * conversão — procure `[csp]` no log da Vercel.
 *
 * Não grava em banco de propósito: relatório de CSP é ruidoso (extensão de
 * navegador injeta script em toda página) e uma tabela aberta ao público é
 * exatamente o que encheu o disco em 28/09. Uma linha de log por combinação
 * nova de diretiva + origem bloqueada, por instância, basta pra decidir.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TETO_BYTES = 8_000;
const TETO_CHAVES = 500;

const globalRef = globalThis as unknown as { __lurdsCspVistos?: Set<string> };
const vistos = globalRef.__lurdsCspVistos ?? new Set<string>();
globalRef.__lurdsCspVistos = vistos;

/** Só a origem: a URL inteira de um script bloqueado pode carregar token. */
function origemDe(valor: unknown): string {
  const s = String(valor ?? '').slice(0, 300);
  if (!s) return '(vazio)';
  try {
    return new URL(s).origin;
  } catch {
    // `inline`, `eval`, `data`, `blob`… — palavra-chave, não URL.
    return s.replace(/[^a-z0-9:._-]/gi, '').slice(0, 60) || '(ilegivel)';
  }
}

function caminhoDe(valor: unknown): string {
  try {
    return new URL(String(valor ?? '')).pathname.slice(0, 80);
  } catch {
    return '';
  }
}

export async function POST(req: Request) {
  const tamanho = Number(req.headers.get('content-length') || 0);
  if (tamanho > TETO_BYTES) return new NextResponse(null, { status: 204 });

  let corpo: unknown;
  try {
    const texto = await req.text();
    if (texto.length > TETO_BYTES) return new NextResponse(null, { status: 204 });
    corpo = JSON.parse(texto);
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  // `report-uri` manda { "csp-report": {...} }; `report-to` manda uma lista.
  const itens = Array.isArray(corpo) ? corpo : [corpo];
  for (const item of itens.slice(0, 5)) {
    const r = (item as Record<string, unknown>)?.['csp-report'] ?? (item as Record<string, unknown>)?.body ?? item;
    if (!r || typeof r !== 'object') continue;
    const reg = r as Record<string, unknown>;
    const diretiva = String(reg['effective-directive'] ?? reg['violated-directive'] ?? reg.effectiveDirective ?? '')
      .split(' ')[0]
      .slice(0, 40);
    const bloqueado = origemDe(reg['blocked-uri'] ?? reg.blockedURL);
    const pagina = caminhoDe(reg['document-uri'] ?? reg.documentURL);
    if (!diretiva) continue;

    const chave = `${diretiva}|${bloqueado}`;
    if (vistos.has(chave)) continue;
    if (vistos.size >= TETO_CHAVES) vistos.clear();
    vistos.add(chave);
    console.log(`[csp] ${diretiva} bloquearia ${bloqueado} em ${pagina || '(pagina)'}`);
  }

  return new NextResponse(null, { status: 204 });
}
