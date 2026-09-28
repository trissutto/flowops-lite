/**
 * LISTA DE COMPRADORAS DO SITE — últimos 12 meses, pro Customer Match do Google Ads.
 *
 * ── A RÉGUA (ordem do dono, 28/09/2026) ──
 *
 * SÓ e-mail de quem COMPROU NO SITE: `source='site'` (WooCommerce, o site
 * antigo) e `source='ecommerce'` (lurds.com.br). Loja física fica de fora, e
 * junto com ela `pdv_online` (venda online do PDV) e `live` — não são compra no
 * site. A lista alimenta a conta de E-COMMERCE; compradora de balcão não é
 * sinal do que o anúncio do site precisa aprender.
 *
 * Carrinho não é compradora: `pending`, `awaiting_payment`, `payment_failed` e
 * `cancelled` ficam fora. O robô do Google aprende com EXEMPLOS — pôr quem não
 * pagou é ensinar errado.
 *
 * ── SÓ LÊ ──
 * A sessão entra em READ ONLY logo depois de conectar.
 *
 * ── COMO RODAR ──
 *   De uma pasta linkada ao Postgres de produção:
 *     railway link --project heroic-mercy --environment production --service Postgres
 *     railway run node backend/scripts/google-customer-match/gerar-lista.js
 *
 * ── SAÍDA (nesta pasta; o .gitignore impede que e-mail de cliente vá pro git) ──
 *   site-12m-email.csv ......... uma coluna, só o e-mail — é o que sobe
 *   site-12m-email-sha256.csv .. o mesmo já hasheado (a API exige hash)
 *   site-12m-completo.csv ...... as MESMAS pessoas com telefone, nome, país e
 *                                CEP. Mais sinal = mais match. Só sobe se o
 *                                dono mandar: a ordem de 28/09 foi "só e-mail".
 */
const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MESES = 12;

/* ─────────────────────────── normalização do Google ─────────────────────────── */

/**
 * E-mail: trim + lowercase, e MAIS NADA.
 *
 * ⚠️ O guia do Google manda tirar ponto e `+tag` de gmail. NÃO tire. Se o Google
 * já normaliza do lado dele, tirar não ganha nada; se não normaliza, você trocou
 * o endereço real da cliente por um que não existe e o match some. É também o
 * que o `google-ads-conversao.service.ts` faz — e aquele caminho já casa
 * conversão nesta mesma conta (conferido contra a API com validateOnly em
 * 02/09). Na base real isso não mudou uma linha sequer.
 */
function normEmail(v) {
  if (!v) return null;
  const e = String(v).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null;
  // Lixo que aparece em base de loja: e-mail inventado pra fechar cadastro.
  if (/^(nao|não)?tem@|^sem@|^naotem|^x@x|^a@a|^teste@|@teste\.|@exemplo\./.test(e)) return null;
  return e;
}

/**
 * E.164. ⚠️ `Order.customerPhone` é gravado SEM DDI — o 55 entra aqui, e só
 * quando não veio. Celular = DDD(2)+9 = 11 dígitos; fixo = DDD(2)+8 = 10.
 */
function normFone(v) {
  if (!v) return null;
  let d = String(v).replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  return `+55${d}`;
}

/** O Google quer primeiro e último separados, sem acento. */
function partesNome(v) {
  if (!v) return { first: '', last: '' };
  const p = String(v)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z\s]/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((x) => x.length > 1 && !['de', 'da', 'do', 'dos', 'das', 'e'].includes(x));
  return p.length < 2 ? { first: '', last: '' } : { first: p[0], last: p[p.length - 1] };
}

function normCep(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 8 ? d : '';
}

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

module.exports = { normEmail, normFone, partesNome, normCep };
if (require.main !== module) return;

/* ─────────────────────────────────── consulta ─────────────────────────────────── */

(async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  const log = (...a) => console.log(...a);

  // Mesma régua de "vendeu" do DRE e da ficha do cliente.
  const VENDIDO = ['paid', 'separating', 'ready', 'shipped', 'delivered', 'completed', 'finished'];

  log(`\n=== COMPRADORAS DO SITE — ÚLTIMOS ${MESES} MESES ===\n`);

  const r = await db.query(
    `SELECT source, customer_email AS email, customer_phone AS fone,
            customer_name AS nome, shipping_cep AS cep
       FROM orders
      WHERE COALESCE(paid_at, wc_date_created, created_at) >= now() - interval '${MESES} months'
        AND source IN ('site', 'ecommerce')
        AND status <> 'cancelled'
        AND (status = ANY($1::text[]) OR paid_at IS NOT NULL)`,
    [VENDIDO],
  );
  const porFonte = {};
  for (const l of r.rows) porFonte[l.source] = (porFonte[l.source] || 0) + 1;
  log(`pedidos vendidos no site: ${r.rowCount}`);
  log(`  WooCommerce (site antigo): ${porFonte.site || 0}`);
  log(`  lurds.com.br (site novo) : ${porFonte.ecommerce || 0}`);

  /* Dedup pelo E-MAIL, e SÓ por ele. Fundir por telefone juntaria mãe e filha
   * que usam o mesmo celular e jogaria fora um e-mail bom — na base real 132
   * telefones têm mais de um e-mail. Numa lista cuja chave é o e-mail, o
   * telefone não decide quem é quem. */
  const porEmail = new Map();
  let semEmail = 0;
  for (const l of r.rows) {
    const email = normEmail(l.email);
    if (!email) {
      semEmail++;
      continue;
    }
    const novo = { email, fone: normFone(l.fone), ...partesNome(l.nome), cep: normCep(l.cep) };
    const atual = porEmail.get(email);
    if (!atual) {
      porEmail.set(email, novo);
      continue;
    }
    // Mesma cliente comprando de novo: fica com o registro mais completo.
    for (const c of ['fone', 'first', 'last', 'cep']) atual[c] = atual[c] || novo[c];
  }

  const linhas = [...porEmail.values()];

  /* ─────────────────────────────── arquivos ─────────────────────────────── */

  const grava = (nome, conteudo) =>
    fs.writeFileSync(path.join(__dirname, nome), conteudo.join('\n') + '\n', 'utf8');

  grava('site-12m-email.csv', ['Email', ...linhas.map((l) => l.email)]);
  grava('site-12m-email-sha256.csv', ['Email', ...linhas.map((l) => sha(l.email))]);

  // O Google só aceita o bloco de endereço COMPLETO (nome + sobrenome + país +
  // CEP). Faltando um, os quatro saem vazios: meio endereço derruba a linha
  // inteira em vez de ajudar o match.
  const completo = (l) => l.first && l.last && l.cep;
  grava('site-12m-completo.csv', [
    'Email,Phone,First Name,Last Name,Country,Zip',
    ...linhas.map((l) => {
      const ok = completo(l);
      return [l.email, l.fone || '', ok ? l.first : '', ok ? l.last : '', ok ? 'BR' : '', ok ? l.cep : ''].join(',');
    }),
  ]);

  const pct = (n) => `${((n / linhas.length) * 100).toFixed(0)}%`;
  const comFone = linhas.filter((l) => l.fone).length;
  const comEnd = linhas.filter(completo).length;
  log(`\n=== RESULTADO ===`);
  log(`  E-MAILS ÚNICOS DE COMPRADORAS DO SITE: ${linhas.length}`);
  log(`  pedidos sem e-mail aproveitável ...... ${semEmail}`);
  log(`  (mínimo que o Google recomenda pra servir anúncio: 5.000)`);
  log(`\n  das MESMAS pessoas, se um dia quiser enriquecer:`);
  log(`     telefone ... ${comFone} (${pct(comFone)})   nome+CEP ... ${comEnd} (${pct(comEnd)})`);
  log(`\n  arquivos em ${__dirname}\n`);

  await db.end();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
