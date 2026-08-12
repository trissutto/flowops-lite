import 'server-only';
import { lerDimensoes, type Dimensoes } from '@/lib/dimensoes-imagem';

/**
 * TAMANHO REAL DA ARTE DO BANNER — servidor.
 *
 * Por que o site mede em vez de o cadastro guardar: as campanhas que já estão
 * no ar foram subidas sem esse dado, e banner é conteúdo que o dono troca
 * sozinho pela retaguarda. Medir na leitura conserta o que já existe e o que
 * vier depois, sem migration e sem deploy de backend (que reinicia o Railway
 * em horário de loja aberta).
 *
 * CUSTO: uma requisição de 64 KB por arte, cacheada por 24h no cache de dados
 * do Next. A home revalida de hora em hora e reaproveita a medição — na
 * prática são duas requisições por dia, não por visita.
 *
 * FALHA É SILENCIOSA DE PROPÓSITO: R2 fora do ar, formato exótico ou arquivo
 * truncado devolvem `null` e o hero volta a se virar com a proporção padrão.
 * Banner é enfeite; a home não cai por causa dele (mesma regra de
 * `services/banners`).
 */

/** O suficiente pro cabeçalho de qualquer formato — o `ispe` do AVIF é o mais fundo. */
const BYTES_DO_CABECALHO = 64 * 1024;

/** Um dia: a arte de um banner não muda sem mudar de URL (o R2 usa uuid no nome). */
const REVALIDATE = 60 * 60 * 24;

/** Acima disto o servidor ignorou o `Range` e baixar não vale a pena. */
const TETO_SEM_RANGE = 4 * 1024 * 1024;

export async function medirArte(url: string | undefined | null): Promise<Dimensoes | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${BYTES_DO_CABECALHO - 1}` },
      next: { revalidate: REVALIDATE, tags: ['banners'] },
    });
    if (!res.ok) return null;

    // 206 = o R2 honrou o Range. 200 = mandou o arquivo inteiro; só seguimos
    // se for pequeno, senão a home pagaria megabytes por um dado de enfeite.
    if (res.status !== 206) {
      const tamanho = Number(res.headers.get('content-length') || 0);
      if (tamanho > TETO_SEM_RANGE) return null;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    return lerDimensoes(bytes.subarray(0, BYTES_DO_CABECALHO));
  } catch (e) {
    console.error(`[medir-arte] não consegui medir ${url}: ${String(e)}`);
    return null;
  }
}
