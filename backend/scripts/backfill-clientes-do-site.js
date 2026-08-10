/**
 * RESGATE DOS CLIENTES QUE O SITE PERDEU.
 *
 *   node scripts/backfill-clientes-do-site.js            # confere, não grava
 *   node scripts/backfill-clientes-do-site.js --aplicar  # grava
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * `Customer.email` é `@unique`, mas o CPF deixou de ser em jun/2026 porque a
 * regra da casa é "CPF é a PESSOA". Quando duas pessoas de verdade dividiam um
 * e-mail, o cadastro da segunda estourava violação de unicidade, caía num
 * `catch` que só logava um warning, e o pedido seguia sem ela. Ninguém
 * percebia: o pedido está lá, a cliente não.
 *
 * O `upsertCustomer` já foi corrigido (grava sem e-mail quando ele é de
 * outra pessoa), mas isso vale só dali pra frente — quem já passou pelo
 * buraco continua fora do CRM. Este script vai atrás dessas.
 *
 * ── O QUE ELE NÃO FAZ ──
 *
 * Não inventa cadastro sem CPF: sem CPF não há como saber se é pessoa nova ou
 * a mesma de outro pedido, e duplicar cliente no CRM é pior que faltar um.
 * Não toca em quem já existe — nem pra "completar", porque cadastro de loja
 * física foi digitado por vendedora olhando documento e vale mais que
 * formulário preenchido com pressa.
 */
const { Client } = require('pg');

const APLICAR = process.argv.includes('--aplicar');
const digits = (v) => String(v || '').replace(/\D/g, '');

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const { rows: pedidos } = await c.query(
    `SELECT DISTINCT ON (customer_cpf)
            id, wc_order_number, source, status, customer_name, customer_email,
            customer_phone, customer_cpf, created_at
       FROM orders
      WHERE source IN ('ecommerce', 'site')
        AND coalesce(customer_cpf, '') <> ''
      ORDER BY customer_cpf, created_at ASC`,
  );

  const faltando = [];
  for (const p of pedidos) {
    const cpf = digits(p.customer_cpf);
    if (cpf.length !== 11) continue;
    const fmt = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
    const { rows: existe } = await c.query(
      `SELECT id FROM customers WHERE cpf IN ($1, $2) OR person_key = $3 LIMIT 1`,
      [cpf, fmt, `cpf:${cpf}`],
    );
    if (existe.length) continue;

    // O e-mail só entra se estiver livre — é a mesma regra do upsertCustomer.
    const email = String(p.customer_email || '').trim().toLowerCase() || null;
    let emailLivre = null;
    if (email) {
      const { rows: dono } = await c.query(`SELECT id, name FROM customers WHERE lower(email) = $1 LIMIT 1`, [email]);
      emailLivre = dono.length ? null : email;
      if (dono.length) {
        console.log(`  ⚠ ${p.customer_name}: e-mail ${email} já é de "${dono[0].name}" — entra sem e-mail`);
      }
    }
    faltando.push({ ...p, cpf, emailLivre });
  }

  console.log(`\npedidos do site com CPF: ${pedidos.length} | clientes faltando no CRM: ${faltando.length}\n`);
  faltando.forEach((f) =>
    console.log(
      `  ${String(f.wc_order_number || f.id).padEnd(12)} ${String(f.customer_name || '-').slice(0, 32).padEnd(32)}`,
      `cpf:${f.cpf} tel:${digits(f.customer_phone) || '-'} email:${f.emailLivre || '(sem)'}`,
    ),
  );

  if (!APLICAR) {
    console.log('\n*** SECO — nada foi gravado. Rode com --aplicar ***');
    await c.end();
    return;
  }

  let n = 0;
  for (const f of faltando) {
    await c.query(
      `INSERT INTO customers (id, name, email, phone, cpf, person_key, origin_source, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'site', NOW(), NOW())`,
      [f.customer_name || null, f.emailLivre, digits(f.customer_phone) || null, f.cpf, `cpf:${f.cpf}`],
    );
    n++;
  }
  console.log(`\n*** ${n} cliente(s) criado(s) no CRM ***`);
  await c.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
