// Gera um HTML com 1 botão wa.me por cliente (mensagem já pré-escrita) pra envio MANUAL.
const { Client } = require('pg');
const fs = require('fs');

const FOTO = 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/whatsapp-reativacao/linha-conforto-terracota.png';
const V = [
  (n) => `Oi ${n}! 💛 Vi que você comprou com a gente em julho. Chegou coisa nova da Linha Conforto no site novo e achei que ia ser a sua cara. Posso te mandar?`,
  (n) => `${n}, tudo bem? 🧡 Aqui é da Lurd's. Saiu a Linha Conforto nova (aquela gostosa de vestir) e lembrei de você. Quer ver?`,
  (n) => `Oi ${n} 💛 Faz um tempinho desde julho! Entrou a Linha Conforto no site novo. Qual número você usa hoje? Te ajudo a achar a sua.`,
  (n) => `${n}, oi! 🧡 Novidade da Linha Conforto no ar — plus do 46 ao 60. Como você comprou em julho, quis te avisar primeiro. Te mostro?`,
];
const primeiroNome = (nome) => { const t = String(nome).trim().split(/\s+/)[0] || ''; return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase(); };
const foneValido = (d) => { d = String(d).replace(/\D/g, ''); return d.length === 12 || d.length === 13; }; // 55+DDD+8/9

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const janela = `(last_order_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') >= '2026-07-01' AND (last_order_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') < '2026-08-01'`;
  const cond = `COALESCE(NULLIF(regexp_replace(COALESCE(whatsapp,''),'\\D','','g'),''), regexp_replace(COALESCE(phone,''),'\\D','','g'))`;
  const r = await db.query(
    `SELECT name, ${cond} AS fone FROM "customers"
      WHERE ${janela} AND name IS NOT NULL AND LENGTH(${cond}) >= 10 AND (gender IS NULL OR gender NOT ILIKE 'm%')
      ORDER BY ltv_cents DESC NULLS LAST LIMIT 30`);
  const norm = (d) => { d = String(d).replace(/\D/g, ''); if (d.length <= 11) d = '55' + d; return d; };
  const homens = ['Valdir', 'Andre', 'André'];
  const rows = r.rows.map((x) => ({ nome: primeiroNome(x.name), fone: norm(x.fone) }))
    .filter((x) => !homens.includes(x.nome)).slice(0, 28);

  const cards = rows.map((x, i) => {
    const msg = V[i % 4](x.nome);
    const link = `https://wa.me/${x.fone}?text=${encodeURIComponent(msg)}`;
    const suspeito = !foneValido(x.fone);
    return `<div class="c${suspeito ? ' susp' : ''}">
      <label><input type="checkbox"> <b>${i + 1}. ${x.nome}</b> <span class="f">${x.fone}${suspeito ? ' ⚠️ número estranho, confira' : ''}</span></label>
      <p class="m">${msg.replace(/</g, '&lt;')}</p>
      <a class="b" href="${link}" target="_blank" rel="noopener">Abrir no WhatsApp ➜</a>
    </div>`;
  }).join('\n');

  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reativação Julho — 28</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial;background:#faf9f7;margin:0;padding:16px;color:#2b2b2b}
h1{font-size:19px}.sub{color:#777;font-size:13px;margin:-6px 0 14px}
.c{background:#fff;border:1px solid #e7e2d8;border-radius:12px;padding:12px 14px;margin:0 0 10px;max-width:620px}
.c.susp{border-color:#e6b800;background:#fffdf3}.f{color:#999;font-size:12px}
.m{font-size:14px;line-height:1.5;color:#3a3630;margin:8px 0 10px}
.b{display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px}
.foto{max-width:620px;background:#fff;border:1px solid #e7e2d8;border-radius:12px;padding:12px 14px;margin:0 0 14px;font-size:13px}
input{transform:scale(1.3);margin-right:6px}b{font-size:15px}</style>
<h1>💛 Reativação Julho — 28 clientes</h1>
<p class="sub">Clique em "Abrir no WhatsApp": a mensagem já vai escrita. Confira o nome, aperte enviar, marque o ✔. Se ela responder "quero", aí você manda a foto abaixo.</p>
<div class="foto">📸 <b>Foto pra mandar quando ela responder:</b><br><a href="${FOTO}" target="_blank">${FOTO}</a></div>
${cards}
<p class="sub">Ritmo humano: manda aos poucos (ex.: 5-6 por vez, com intervalos). Se muita gente não responder ou bloquear, para e me avisa.</p>`;

  const out = process.env.OUT || 'reativacao-julho-links.html';
  fs.writeFileSync(out, html);
  console.log('HTML:', out, '|', rows.length, 'clientes');
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
