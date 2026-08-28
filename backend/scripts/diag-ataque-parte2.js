/**
 * Parte 2 do diagnóstico do ataque de teste de cartão:
 *  A. algum pedido do ataque foi APROVADO/pago?
 *  B. os CPFs do bot passam no dígito verificador? (decide se validar CPF já mata o ataque)
 *  C. parcelas usadas pelo bot (assinatura extra)
 *  D. ritmo dos últimos 15 minutos (o ataque ainda está rodando?)
 *
 *   railway run node backend/scripts/diag-ataque-parte2.js   (na pasta linkada ao heroic-mercy)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function cpfValido(cpf) {
  const s = String(cpf || '').replace(/\D/g, '');
  if (s.length !== 11 || /^(\d)\1{10}$/.test(s)) return false;
  for (const [len, mult] of [[9, 10], [10, 11]]) {
    let soma = 0;
    for (let i = 0; i < len; i++) soma += Number(s[i]) * (mult - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(s[len])) return false;
  }
  return true;
}

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('── A. pedidos de HOJE que NÃO são payment_failed (algum teste aprovado?) ──');
  const pagos = await db.query(
    `SELECT wc_order_number lp, status, customer_name nome, customer_email email,
            customer_cpf cpf, cliente_ip ip, total_amount total, paid_at,
            to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') criado,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb->>'method' END metodo
       FROM orders
      WHERE source='ecommerce' AND status <> 'payment_failed'
        AND created_at > NOW() - INTERVAL '30 hours'
      ORDER BY created_at DESC`,
  );
  console.table(pagos.rows);

  console.log('── B. validade do CPF nos payment_failed de hoje ──');
  const cpfs = await db.query(
    `SELECT customer_cpf cpf, customer_email email FROM orders
      WHERE status='payment_failed' AND created_at > NOW() - INTERVAL '30 hours'`,
  );
  let validos = 0, invalidos = 0;
  const exValidos = [], exInvalidos = [];
  for (const r of cpfs.rows) {
    if (cpfValido(r.cpf)) { validos++; if (exValidos.length < 5) exValidos.push(`${r.cpf} ${r.email}`); }
    else { invalidos++; if (exInvalidos.length < 5) exInvalidos.push(`${r.cpf} ${r.email}`); }
  }
  console.log(`CPF VÁLIDO: ${validos}   CPF INVÁLIDO: ${invalidos}  (de ${cpfs.rows.length})`);
  console.log('exemplos válidos:', exValidos);
  console.log('exemplos inválidos:', exInvalidos);

  console.log('── B2. e o histórico: payment_failed ANTIGO (antes de 28/08) com CPF inválido? ──');
  const antigos = await db.query(
    `SELECT customer_cpf cpf FROM orders
      WHERE status='payment_failed' AND created_at < NOW() - INTERVAL '30 hours'`,
  );
  let vAnt = 0, iAnt = 0;
  for (const r of antigos.rows) (cpfValido(r.cpf) ? vAnt++ : iAnt++);
  console.log(`antigos: válidos=${vAnt} inválidos=${iAnt} (de ${antigos.rows.length})`);

  console.log('── B3. pedidos LEGÍTIMOS (pagos, 30 dias): algum com CPF inválido? ──');
  const legit = await db.query(
    `SELECT customer_cpf cpf, wc_order_number lp FROM orders
      WHERE source IN ('ecommerce','loja') AND paid_at IS NOT NULL
        AND created_at > NOW() - INTERVAL '30 days'`,
  );
  let vLeg = 0; const iLeg = [];
  for (const r of legit.rows) (cpfValido(r.cpf) ? vLeg++ : iLeg.push(`${r.lp}:${r.cpf}`));
  console.log(`pagos 30d: válidos=${vLeg} inválidos=${iLeg.length}`, iLeg.slice(0, 10));

  console.log('── C. parcelas nos payment_failed de hoje ──');
  const parc = await db.query(
    `SELECT CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb->>'installments' END parcelas,
            COUNT(*)::int n
       FROM orders
      WHERE status='payment_failed' AND created_at > NOW() - INTERVAL '30 hours'
      GROUP BY 1 ORDER BY n DESC`,
  );
  console.table(parc.rows);

  console.log('── D. ritmo: payment_failed por minuto, últimos 20 min ──');
  const ritmo = await db.query(
    `SELECT to_char(date_trunc('minute', created_at AT TIME ZONE 'America/Sao_Paulo'),'HH24:MI') minuto,
            COUNT(*)::int n
       FROM orders
      WHERE status='payment_failed' AND created_at > NOW() - INTERVAL '20 minutes'
      GROUP BY 1 ORDER BY 1`,
  );
  console.table(ritmo.rows);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
