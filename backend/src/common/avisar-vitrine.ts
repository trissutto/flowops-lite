import { Logger } from '@nestjs/common';

/**
 * "MEXEU NA RETAGUARDA, O SITE MUDA NA HORA" (dono, 07/08/2026).
 *
 * A vitrine guarda as páginas prontas por 1 hora (ISR). Ótimo pra velocidade,
 * péssimo pra quem acabou de gravar: o dono publicava o banner, abria o site,
 * via o hero antigo e mexia tudo de novo achando que não tinha salvo. Não há
 * erro em lugar nenhum — é cache, e cache não se explica sozinho.
 *
 * Pior ainda em trabalho de LOTE (classificar 300 peças): a pessoa classifica,
 * não vê nada mudar, e conclui que a ferramenta não funciona.
 *
 * Aqui a retaguarda avisa: gravou → a tag cai → a próxima visita monta a
 * página nova.
 *
 * ── POR QUE NÃO DEPENDE MAIS DE ENV NOVA (13/08/2026) ──
 *
 * Isto ficou SEIS DIAS desligado sem ninguém notar. O aviso exigia duas envs
 * novas (`ECOMMERCE_URL` + `REVALIDATE_SECRET`) criadas à mão em dois projetos
 * diferentes; faltou uma e a função virou `return` mudo. O site respondia
 * 503 "revalidação não configurada" e todo save voltava a esperar a hora do
 * ISR — a queixa original, de volta, com o código do conserto no repositório.
 *
 * Regra que ficou: mecanismo de conforto não pode nascer dependendo de setup
 * manual. Os dois valores agora têm fallback pro que JÁ está configurado em
 * produção — `LOJA_ORDER_TOKEN` (o segredo que o site usa pra falar com o
 * backend) e o domínio da vitrine. Falhou mesmo assim? Continua sendo enfeite:
 * o cache de 1 hora resolve, como sempre resolveu.
 *
 * ── NUNCA LANÇA, NUNCA ESPERA ──
 *
 * Site fora do ar não pode impedir a retaguarda de gravar.
 */

/** Domínio da vitrine — só entra se `ECOMMERCE_URL` não estiver configurada. */
const VITRINE_PADRAO = 'https://www.lurdsplussize.com.br';

/**
 * Todas as vitrines a avisar. `ECOMMERCE_URL` aceita lista separada por
 * vírgula e ANTES só a primeira era avisada — com domínio novo e antigo na
 * env, um dos dois ficava com a página velha.
 */
export function urlsDaVitrine(): string[] {
  const bruto = (process.env.ECOMMERCE_URL || '')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter((u) => /^https?:\/\//.test(u));
  if (bruto.length) return [...new Set(bruto)];
  // Sem env: em produção vale o domínio da casa; em dev, ninguém é avisado
  // (senão um `npm run start:dev` local sai furando o cache do site no ar).
  return process.env.NODE_ENV === 'production' ? [VITRINE_PADRAO] : [];
}

/** Ver o comentário do topo: o segredo novo tem prioridade, o velho é a rede. */
export function segredoDaVitrine(): string {
  return (
    (process.env.REVALIDATE_SECRET || '').trim() ||
    (process.env.LOJA_ORDER_TOKEN || '').trim()
  );
}

/**
 * ÚLTIMO RESULTADO, pra tela poder mostrar (ver `GET /site-banners/status-site`).
 *
 * Sem isto, "o site não atualizou" é indistinguível de "o site atualizou e a
 * arte é que está errada" — e foi essa dúvida que fez o dono mexer no banner
 * várias vezes seguidas.
 */
export interface ResultadoAviso {
  quando: string;
  ok: boolean;
  detalhe: string;
  tags: string[];
}
let ultimo: ResultadoAviso | null = null;
export function ultimoAvisoVitrine(): ResultadoAviso | null {
  return ultimo;
}

/**
 * "O SITE ATUALIZA NA HORA?" — resposta pra tela, não pro log.
 *
 * Pergunta ao próprio site se ele tem o segredo, em vez de deduzir pela env
 * daqui: o buraco de 07 a 13/08 foi exatamente uma ponta configurada e a outra
 * não. Só as duas juntas contam.
 */
export async function conferirVitrine(): Promise<{
  ligado: boolean;
  motivo: string | null;
  ultimo: ResultadoAviso | null;
}> {
  const bases = urlsDaVitrine();
  const resposta = (ligado: boolean, motivo: string | null) => ({
    ligado,
    motivo,
    ultimo,
  });

  if (!segredoDaVitrine()) return resposta(false, 'A retaguarda está sem o segredo do site.');
  if (!bases.length) return resposta(false, 'A retaguarda não sabe o endereço do site (ECOMMERCE_URL).');

  try {
    const r = await fetch(`${bases[0]}/api/revalidar`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return resposta(false, `O site respondeu ${r.status}.`);
    const corpo: any = await r.json().catch(() => null);
    if (!corpo?.configurado) return resposta(false, 'O site está sem o segredo de atualização.');
    return resposta(true, null);
  } catch (e: any) {
    return resposta(false, `Não consegui falar com o site: ${e?.message || e}`);
  }
}

export function avisarVitrine(tags: string[], logger: Logger, prefixo: string): void {
  const bases = urlsDaVitrine();
  const segredo = segredoDaVitrine();
  if (!tags.length) return;
  if (!bases.length || !segredo) {
    ultimo = {
      quando: new Date().toISOString(),
      ok: false,
      detalhe: !bases.length ? 'ECOMMERCE_URL não configurada' : 'nenhum segredo configurado',
      tags,
    };
    return;
  }

  for (const base of bases) {
    void fetch(`${base}/api/revalidar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': segredo },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(5000),
    })
      .then((r) => {
        if (!r.ok) logger.warn(`[${prefixo}] site respondeu ${r.status} ao revalidar`);
        ultimo = {
          quando: new Date().toISOString(),
          ok: r.ok,
          detalhe: r.ok ? `${base} ok` : `${base} respondeu ${r.status}`,
          tags,
        };
      })
      .catch((e) => {
        logger.warn(`[${prefixo}] não avisei o site: ${e?.message || e}`);
        ultimo = {
          quando: new Date().toISOString(),
          ok: false,
          detalhe: `${base}: ${e?.message || e}`,
          tags,
        };
      });
  }
}
