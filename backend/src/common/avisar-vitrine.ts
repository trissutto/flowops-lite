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
 * ── NUNCA LANÇA, NUNCA ESPERA ──
 *
 * Site fora do ar não pode impedir a retaguarda de gravar. Falhou? O cache de
 * 1 hora resolve sozinho — volta a ser exatamente o comportamento de antes.
 *
 * Sem `ECOMMERCE_URL` ou `REVALIDATE_SECRET` configurados, não faz nada: é o
 * caso do ambiente local e de quem ainda não ligou a vitrine nova.
 */
export function avisarVitrine(tags: string[], logger: Logger, prefixo: string): void {
  const base = (process.env.ECOMMERCE_URL || '').split(',')[0].trim().replace(/\/$/, '');
  const segredo = (process.env.REVALIDATE_SECRET || '').trim();
  if (!base || !segredo || !tags.length) return;

  void fetch(`${base}/api/revalidar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': segredo },
    body: JSON.stringify({ tags }),
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => {
      if (!r.ok) logger.warn(`[${prefixo}] site respondeu ${r.status} ao revalidar`);
    })
    .catch((e) => logger.warn(`[${prefixo}] não avisei o site: ${e?.message || e}`));
}
