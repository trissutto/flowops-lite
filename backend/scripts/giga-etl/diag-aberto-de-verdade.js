/**
 * "Parcela em aberto" é dinheiro a receber, ou é baixa que ninguém deu?
 *
 * A pergunta do dono, e ela decide se R$ 10 milhões são cobráveis ou fantasma.
 *
 * Três coisas muito diferentes se escondem sob "aberto":
 *
 *   1. RECEBER DE VERDADE — venceu há pouco ou vence à frente, sem pagamento.
 *   2. PAGA MAS NÃO BAIXADA — tem DATA DE PAGAMENTO preenchida e a flag PAGO
 *      não. O dinheiro entrou; só o registro ficou pela metade. Foi o bug
 *      antigo da baixa (erp.service.ts:2420 documenta: "se PAGO ficar nulo, a
 *      baixa não aparece na UI do WinCred mesmo com data preenchida").
 *   3. PODRE — venceu em 2024/2025 e ninguém mexe desde então. Contabilmente
 *      aberta, na prática perda.
 *
 * Somar as três como se fossem a mesma coisa infla o limite da cliente e a
 * dívida da rede.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-aberto-de-verdade.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST, port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER, password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });

  const ABERTO = `(PAGO IS NULL OR PAGO = '' OR UPPER(PAGO) IN ('N','NAO','NÃO'))`;

  // 1. O total que hoje conta como aberto.
  const [[t]] = await my.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(VALORPARCELA),0) AS v FROM movimento WHERE ${ABERTO}`,
  );
  console.log(`TOTAL hoje contado como aberto: ${nf(t.n)} parcelas · ${brl(t.v)}`);

  // 2. Destas, quantas TEM data de pagamento? = dinheiro que entrou.
  const [[pg]] = await my.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(VALORPARCELA),0) AS v
       FROM movimento
      WHERE ${ABERTO} AND PAGAMENTO IS NOT NULL AND PAGAMENTO <> '0000-00-00'`,
  );
  console.log('');
  console.log('--- 2. PAGAS MAS NAO BAIXADAS (tem data de pagamento) ---');
  console.log(`  ${nf(pg.n)} parcelas · ${brl(pg.v)}`);
  console.log('  >> o dinheiro ENTROU. Nao e a receber.');

  // 3. As sem pagamento, por idade do vencimento.
  console.log('');
  console.log('--- 3. AS SEM PAGAMENTO, POR IDADE ---');
  const faixas = [
    ['a vencer (futuro)',        'VENCIMENTO >= CURDATE()'],
    ['vencidas ate 30 dias',     'VENCIMENTO < CURDATE() AND VENCIMENTO >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)'],
    ['vencidas 31-90 dias',      'VENCIMENTO < DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND VENCIMENTO >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)'],
    ['vencidas 91-365 dias',     'VENCIMENTO < DATE_SUB(CURDATE(), INTERVAL 90 DAY) AND VENCIMENTO >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)'],
    ['vencidas ha MAIS DE 1 ANO','VENCIMENTO < DATE_SUB(CURDATE(), INTERVAL 365 DAY)'],
    ['sem data de vencimento',   'VENCIMENTO IS NULL OR VENCIMENTO = \'0000-00-00\''],
  ];
  let somaVivo = 0;
  for (const [nome, cond] of faixas) {
    const [[r]] = await my.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(VALORPARCELA),0) AS v
         FROM movimento
        WHERE ${ABERTO}
          AND (PAGAMENTO IS NULL OR PAGAMENTO = '0000-00-00')
          AND (${cond})`,
    );
    console.log(`  ${nome.padEnd(28)} ${String(nf(r.n)).padStart(7)} · ${brl(r.v).padStart(16)}`);
    if (nome.startsWith('a vencer') || nome.includes('ate 30') || nome.includes('31-90')) {
      somaVivo += Number(r.v);
    }
  }

  // 4. Por ano de vencimento — mostra o quanto e historico parado.
  console.log('');
  console.log('--- 4. POR ANO DE VENCIMENTO (sem pagamento) ---');
  const [anos] = await my.query(
    `SELECT YEAR(VENCIMENTO) AS ano, COUNT(*) AS n, COALESCE(SUM(VALORPARCELA),0) AS v
       FROM movimento
      WHERE ${ABERTO} AND (PAGAMENTO IS NULL OR PAGAMENTO = '0000-00-00')
        AND VENCIMENTO IS NOT NULL AND VENCIMENTO <> '0000-00-00'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
  );
  for (const a of anos) {
    console.log(`  ${a.ano}  ${String(nf(a.n)).padStart(7)} parcelas · ${brl(a.v).padStart(16)}`);
  }

  console.log('');
  console.log('=========================================');
  console.log(`  Contado como aberto hoje:     ${brl(t.v)}`);
  console.log(`  (-) ja pago, so nao baixado:  ${brl(pg.v)}`);
  console.log(`  A RECEBER de verdade (ate 90 dias de atraso): ${brl(somaVivo)}`);
  console.log('');
  console.log('  O resto e historico vencido ha mais de 90 dias — contabilmente');
  console.log('  aberto, mas nao e o que a loja vai receber este mes.');

  await my.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
