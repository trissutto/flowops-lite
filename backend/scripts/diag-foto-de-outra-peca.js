/**
 * A FOTO DE OUTRA PEÇA — varredura por CONTEÚDO do arquivo (18/08/2026).
 *
 * O caso que abriu o assunto: a PDP da `VLM-222` (vestido LISO, R$ 139,90)
 * mostrava a cor "Vinho" com a foto do vestido ESTAMPADO — que é outra REF
 * (`VLM222EST`, R$ 199,90). Não era mistura da família nem cache: as duas
 * linhas de `product_photos` (ref VLM-222 / cor VINHO, subidas em 03/08) são o
 * MESMO ARQUIVO, byte a byte, da foto que está sob VLM222EST / ESTAMPA VINHO.
 * A cliente escolhia o estampado e ia receber um vestido liso vinho.
 *
 * NENHUM dado do banco denuncia isso: a linha tem REF certa, cor certa, e o
 * nome do arquivo diz "VLM-222-VINHO-1.jpg" — quem subiu escolheu o arquivo
 * errado, e o nome mentiu junto. Só o CONTEÚDO entrega.
 *
 * Como a varredura acha: o R2 devolve no header `ETag` o md5 do objeto. Um
 * HEAD por foto (3.600 hoje) e agrupa por ETag — arquivo idêntico gravado em
 * (ref, cor) diferentes é candidato. NÃO é sentença: peça re-cadastrada em
 * duas REFs tem foto repetida de propósito, e detalhe/etiqueta se repete entre
 * cores da mesma peça. A varredura LISTA; quem julga é gente olhando.
 *
 * ⚠️ O domínio público do R2 (`pub-*.r2.dev`) tem rate-limit apertado: com 24
 * requisições em paralelo, 2.963 das 3.600 voltaram 429 e a varredura ficou
 * cega justamente na peça procurada. Daí CONC=4 + pausa + backoff — leva ~12
 * min e vê tudo.
 *
 *   railway run --service Postgres node backend/scripts/diag-foto-de-outra-peca.js
 *   railway run --service Postgres node backend/scripts/diag-foto-de-outra-peca.js --so-refs-diferentes
 *
 * Só lê: nenhum UPDATE, nenhum DELETE.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const SO_REFS_DIFERENTES = process.argv.includes('--so-refs-diferentes');
const CONC = 4;
const PAUSA_MS = 120;
const SAIDA = path.join(__dirname, 'diag-foto-de-outra-peca-saida.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function head(foto) {
  for (let tentativa = 0; tentativa < 8; tentativa++) {
    try {
      const resp = await fetch(foto.url, { method: 'HEAD' });
      // 429 = rate-limit do r2.dev. Espera crescente e tenta de novo: desistir
      // aqui é o que fez a primeira varredura não enxergar a VLM-222.
      if (resp.status === 429) { await sleep(1500 * (tentativa + 1)); continue; }
      return {
        ...foto,
        etag: (resp.headers.get('etag') || '').replace(/"/g, ''),
        bytes: Number(resp.headers.get('content-length') || 0),
        status: resp.status,
      };
    } catch { await sleep(1200 * (tentativa + 1)); }
  }
  return { ...foto, etag: '', bytes: 0, status: 429 };
}

(async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  const { rows: fotos } = await db.query(`
    SELECT p.id, p.ref, p.cor, p.ordem, p.url, p.created_at::date AS dia,
           s.publicado, s.slug
      FROM product_photos p
      LEFT JOIN site_produto s ON s.ref = p.ref
     ORDER BY p.ref, p.cor, p.ordem`);
  console.log(`${fotos.length} fotos no catálogo — medindo o conteúdo de cada uma (${CONC} por vez)…\n`);

  const medidas = [];
  let i = 0, feitas = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < fotos.length) {
      const f = fotos[i++];
      medidas.push(await head(f));
      if (++feitas % 200 === 0) console.log(`  ${feitas}/${fotos.length}`);
      await sleep(PAUSA_MS);
    }
  }));

  const porEtag = new Map();
  for (const m of medidas) {
    if (m.status !== 200 || !m.etag) continue;
    if (!porEtag.has(m.etag)) porEtag.set(m.etag, []);
    porEtag.get(m.etag).push(m);
  }

  const grupos = [];
  for (const [etag, linhas] of porEtag) {
    const chaves = new Set(linhas.map((l) => `${l.ref}|${l.cor}`));
    if (chaves.size < 2) continue;                       // mesma foto, mesma cor = ordem repetida
    const refs = new Set(linhas.map((l) => l.ref));
    if (SO_REFS_DIFERENTES && refs.size < 2) continue;
    grupos.push({ etag, refsDiferentes: refs.size > 1, linhas });
  }
  grupos.sort((a, b) => Number(b.refsDiferentes) - Number(a.refsDiferentes));

  console.log(`\n=== MESMO ARQUIVO em (ref, cor) diferentes: ${grupos.length} grupos ===`);
  for (const g of grupos) {
    console.log(`\n[${g.refsDiferentes ? 'REFS DIFERENTES — olhar' : 'mesma REF, cores diferentes'}] ${Math.round(g.linhas[0].bytes / 1024)}KB`);
    for (const l of g.linhas) {
      console.log(`   ${l.ref} | ${l.cor} | ordem ${l.ordem} | publicado=${l.publicado} | ${String(l.dia).slice(0, 10)}`);
      console.log(`      ${l.url}`);
    }
  }

  const semResposta = medidas.filter((m) => m.status !== 200);
  if (semResposta.length) {
    console.log(`\n⚠️  ${semResposta.length} fotos não responderam (a varredura ficou cega nelas):`);
    for (const m of semResposta.slice(0, 20)) console.log(`   ${m.status} ${m.ref} | ${m.cor} | ${m.url}`);
  }

  fs.writeFileSync(SAIDA, JSON.stringify({ medidas, grupos }, null, 2));
  console.log(`\nmedidas salvas em ${SAIDA}`);
  await db.end();
})();
