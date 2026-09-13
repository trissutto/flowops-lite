/**
 * CONJUNTOS DE LOCAL: o nome bate com o conteúdo? — conta LOJAS FÍSICAS. Só leitura.
 *
 * ── POR QUE ISTO EXISTE ANTES DE QUALQUER EXCLUSÃO ──
 *
 * Há conjuntos de ativos de local com rótulo de uma cidade pendurados em campanha
 * de outra (um "MOEMA 2025" aparecendo na SANTOS). A tentação é apagar.
 *
 * 🚨 **Apagar pode quebrar campanha viva.** O mesmo conjunto "MOEMA 2025" é,
 * quase certamente, o conjunto LEGÍTIMO da campanha de Moema — o que está errado
 * é um VÍNCULO velho para Santos, que já está REMOVED e portanto já não faz
 * estrago. Excluir o conjunto por causa do vínculo morto derrubaria a Moema.
 *
 * A memória do projeto avisa exatamente isso: o NOME do conjunto MENTE; quem
 * decide é o `store_code` do ativo lá dentro, nunca o rótulo.
 *
 * Então este script responde três perguntas, e só depois se decide:
 *   1. Que conjunto está ENABLED em cada campanha, e qual loja está dentro dele?
 *   2. O nome do conjunto bate com a cidade da campanha e com o store_code?
 *   3. Existe algum conjunto ÓRFÃO — sem nenhum vínculo ENABLED em campanha
 *      nenhuma? Esse sim é candidato a exclusão, e só esse.
 *
 *   railway run --service flowops-lite node backend/scripts/diag-google-ads-lojas-conjuntos.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';

async function token() {
  const b = new URLSearchParams({
    client_id: (process.env.GOOGLE_ADS_CLIENT_ID || '').trim(),
    client_secret: (process.env.GOOGLE_ADS_CLIENT_SECRET || '').trim(),
    refresh_token: (process.env.GOOGLE_ADS_REFRESH_TOKEN || '').trim(),
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth falhou');
  return j.access_token;
}

function headers(a) {
  const h = {
    Authorization: `Bearer ${a}`,
    'developer-token': (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim(),
    'Content-Type': 'application/json',
  };
  const mcc = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').trim().replace(/\D/g, '');
  if (mcc) h['login-customer-id'] = mcc;
  return h;
}

function erroLegivel(t) {
  try {
    const bruto = JSON.parse(t);
    const j = Array.isArray(bruto) ? bruto[0] : bruto;
    const errs = j.error?.details?.[0]?.errors || [];
    const quota = errs.find((e) => e.errorCode?.quotaError);
    if (quota) {
      const s = /Retry in (\d+) seconds/.exec(quota.message || '')?.[1];
      return `COTA ESGOTADA${s ? ` — o Google pede ${s}s ≈ ${(s / 3600).toFixed(1)}h` : ''}`;
    }
    return errs.map((e) => `${JSON.stringify(e.errorCode)}: ${e.message}`).join(' | ') || j.error?.message || t;
  } catch {
    return t;
  }
}

async function consultar(a, gaql) {
  const r = await fetch(
    `https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`,
    { method: 'POST', headers: headers(a), body: JSON.stringify({ query: gaql }) },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 500)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

/** Tira acento e caixa pra comparar "ANÁLIA FRANCO" com "analia franco". */
const norm = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

async function main() {
  console.log(`conta ${CONTA} · API ${V} · SÓ LEITURA\n`);
  const a = await token();

  /* Todos os vínculos campanha↔conjunto, COM o status dos dois lados. */
  const vinculos = await consultar(
    a,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign_asset_set.status, asset_set.id, asset_set.name, asset_set.type, asset_set.status
       FROM campaign_asset_set`,
  );

  /* O que existe DENTRO de cada conjunto — o store_code é quem manda. */
  const conteudo = await consultar(
    a,
    `SELECT asset_set.id, asset_set.name, asset_set_asset.status,
            asset.id, asset.location_asset.business_profile_locations
       FROM asset_set_asset`,
  );
  const dentro = new Map();
  for (const x of conteudo) {
    if (x.assetSetAsset.status === 'REMOVED') continue;
    const sid = String(x.assetSet.id);
    const lojas = (x.asset?.locationAsset?.businessProfileLocations || []).map((b) => b.storeCode).filter(Boolean);
    dentro.set(sid, [...(dentro.get(sid) || []), ...(lojas.length ? lojas : [`asset ${x.asset?.id}`])]);
  }

  /* ── 1) O QUE ESTÁ VIVO ──────────────────────────────────────────────── */
  const vivos = vinculos.filter(
    (x) => x.campaign.status === 'ENABLED' && x.campaignAssetSet.status !== 'REMOVED',
  );
  console.log('VÍNCULOS VIVOS (campanha ENABLED + vínculo não removido)');
  console.log('campanha                                    conjunto                    lojas dentro   nome bate?');
  const setsEmUso = new Set();
  for (const x of vivos.sort((p, q) => p.campaign.name.localeCompare(q.campaign.name))) {
    const sid = String(x.assetSet.id);
    setsEmUso.add(sid);
    const lojas = dentro.get(sid) || [];
    /* "bate" = o nome do conjunto contém alguma palavra do nome da campanha. */
    const palavras = norm(x.campaign.name).split(' ').filter((p) => p.length > 3 && !['PMAX', 'PETTER', 'SEARCH', 'BASE'].includes(p));
    const bate = palavras.some((p) => norm(x.assetSet.name).includes(p));
    console.log(
      `${String(x.campaign.name).slice(0, 42).padEnd(43)} ${String(x.assetSet.name).slice(0, 26).padEnd(27)} ` +
        `${lojas.join(',').slice(0, 13).padEnd(14)} ${bate ? 'sim' : '⚠️ NÃO'}`,
    );
  }

  /* ── 2) ÓRFÃOS — os únicos candidatos a exclusão ─────────────────────── */
  const todosSets = new Map();
  for (const x of vinculos) todosSets.set(String(x.assetSet.id), x.assetSet);
  for (const x of conteudo) todosSets.set(String(x.assetSet.id), x.assetSet);

  const orfaos = [...todosSets.values()].filter((s) => !setsEmUso.has(String(s.id)));
  console.log(`\nCONJUNTOS SEM NENHUM VÍNCULO VIVO: ${orfaos.length}`);
  for (const s of orfaos.sort((p, q) => String(p.name).localeCompare(String(q.name)))) {
    const lojas = dentro.get(String(s.id)) || [];
    console.log(`  ${String(s.id).padEnd(12)} ${String(s.status).padEnd(9)} ${String(s.name).slice(0, 32).padEnd(33)} conteúdo: ${lojas.join(',') || '(vazio)'}`);
  }

  console.log(
    `\n── LEITURA ──` +
      `\nSó os ÓRFÃOS acima poderiam ser excluídos sem risco. Conjunto que aparece na` +
      `\nlista de VÍNCULOS VIVOS está em uso AGORA — apagar derruba a campanha, mesmo` +
      `\nque o nome dele fale de outra cidade.` +
      `\n\nPara os que aparecem com "⚠️ NÃO" no nome: o conserto certo é RENOMEAR, não` +
      `\nexcluir. O nome é o que engana quem for mexer depois; o conteúdo já está certo.`,
  );
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
