import { NextResponse } from 'next/server';

/**
 * BFF DA PEÇA — usado pelo Quick Add.
 *
 * A listagem devolve a peça resumida; pra adicionar à sacola sem sair da
 * página é preciso a grade REAL da cor escolhida (cada cor tem estoque
 * próprio). Este proxy entrega isso sem expor a API no bundle.
 *
 * SEM cache: é a grade com estoque que decide se o tamanho é clicável. O
 * revalidate serve stale primeiro (SWR) — com pouco tráfego o Quick Add
 * oferecia tamanho esgotado horas depois da venda (caso VOGUE VINHO 06/08).
 *
 * ── POR QUE TEM RETRY (27/08) ──
 *
 * Alerta da Vercel: 8,6% de 502 nesta rota (10 de 116 requisições). Medido com
 * sonda de 2s por ~4h, com controle externo pra descartar internet local:
 *
 *   · deploy do backend → API inteira fora ~20s (3 ocorrências no dia);
 *   · soluço no caminho Vercel→Railway → 3-4s (3 ocorrências), com o backend
 *     respondendo 200 pra quem chama do Brasil no MESMO instante.
 *
 * O segundo tipo é curto e some sozinho — mas UMA falha de conexão virava 502
 * na cara da cliente, porque aqui não havia tentativa nenhuma. Duas tentativas
 * extras cobrem a janela inteira desses soluços.
 *
 * Cache continua PROIBIDO nesta rota (ver acima): retry busca dado FRESCO de
 * novo, que é diferente de servir stale.
 */

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

/** Tentativas totais e espera entre elas. ~1s no pior caso. */
const TENTATIVAS = 3;
const ESPERA_MS = [250, 700];
/** Teto por tentativa: sem isso um upstream pendurado segura a página inteira. */
const TIMEOUT_MS = 8000;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!BASE_URL) {
    return NextResponse.json({ erro: 'indisponivel' }, { status: 503 });
  }

  const url = `${BASE_URL}/public/loja/produto/${encodeURIComponent(slug)}`;
  let ultimoErro: unknown = null;
  let ultimoStatus = 0;

  for (let tentativa = 0; tentativa < TENTATIVAS; tentativa++) {
    if (tentativa > 0) await dormir(ESPERA_MS[tentativa - 1] ?? 700);
    try {
      const upstream = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (upstream.ok) return NextResponse.json(await upstream.json());

      ultimoStatus = upstream.status;
      /**
       * 4xx NÃO SE REPETE. Peça que não existe (404) continua não existindo na
       * segunda tentativa — insistir só atrasa a resposta da cliente e bate no
       * backend à toa. Só 5xx (o backend caiu/reiniciou) merece nova chance.
       */
      if (upstream.status < 500) {
        return NextResponse.json({ erro: 'nao-encontrado' }, { status: upstream.status });
      }
    } catch (error) {
      // Conexão estourou (rede Vercel→Railway, timeout): vale tentar de novo.
      ultimoErro = error;
    }
  }

  console.error(
    `[loja] peça ${slug} falhou após ${TENTATIVAS} tentativas` +
      (ultimoStatus ? ` (último status ${ultimoStatus})` : ''),
    ultimoErro,
  );
  return NextResponse.json({ erro: 'falha' }, { status: ultimoStatus >= 500 ? ultimoStatus : 502 });
}
