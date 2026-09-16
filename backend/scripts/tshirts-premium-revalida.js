/**
 * Avisa a vitrine depois do `tshirts-premium-classifica.js`.
 *
 * O script de classificação grava direto no `site_produto` — o backend remonta
 * o catálogo sozinho (a impressão digital de `site_produto` muda), mas a
 * PÁGINA da categoria é ISR no Next e continuaria servindo a grade velha até o
 * TTL. Este script faz a mesma chamada do `common/avisar-vitrine.ts`, com as
 * MESMAS envs do backend — por isso roda no serviço do app:
 *
 *   railway run --service flowops-lite node backend/scripts/tshirts-premium-revalida.js
 */
const TAGS = [
  'categorias', 'filtros', 'catalogo',
  'categoria:t-shirts-premium', 'categoria:blusas', 'categoria:linha-conforto',
];

const bases = (process.env.ECOMMERCE_URL || 'https://lurds.com.br')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const segredo = (process.env.REVALIDATE_SECRET || process.env.LOJA_ORDER_TOKEN || '').trim();

(async () => {
  if (!segredo) { console.error('sem REVALIDATE_SECRET/LOJA_ORDER_TOKEN — rode com --service flowops-lite'); process.exit(1); }
  for (const base of bases) {
    const r = await fetch(`${base}/api/revalidar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': segredo },
      body: JSON.stringify({ tags: TAGS }),
    });
    console.log(base, '→', r.status, (await r.text()).slice(0, 200));
  }
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
