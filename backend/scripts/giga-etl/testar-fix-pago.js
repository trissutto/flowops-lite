/**
 * A correção do `pagoOf` funciona? Teste contra as linhas REAIS do Giga,
 * antes do deploy.
 *
 * O backend não roda local, então não dá pra testar o serviço de verdade. Mas
 * a regra é pura: recebe uma linha, devolve pago/não-pago. Dá pra replicar as
 * duas versões aqui e rodar sobre a tabela inteira.
 *
 * Baliza: o critério OFICIAL de "em aberto" do sistema, em
 * `crediario-mirror.service.ts:118`:
 *   aberto ⇔ PAGO IS NULL OR PAGO = '' OR UPPER(PAGO) IN ('N','NAO','NÃO')
 *
 * O teste passa quando a versão NOVA concorda 100% com essa baliza e a ANTIGA
 * não — provando que o bug existia e que a correção o elimina.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/testar-fix-pago.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');

// ── helpers copiados do serviço, sem alteração ───────────────────────────
const pick = (row, ...res) => {
  for (const re of res) for (const k of Object.keys(row)) if (re.test(k)) return row[k];
  return undefined;
};
const str = (v, max = 250) => {
  if (v == null) return null;
  const s = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
  const t = s.trim();
  return t ? t.slice(0, max) : null;
};
const dateOf = (v) => {
  if (!v || String(v).startsWith('0000')) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime()) || d.getFullYear() < 1950) return null;
  return d;
};
const RE_PAGO = [/^pago$/i, /^pg$/i, /^baixado$/i, /^quitado$/i];
const RE_DATA = [/^pagamento$/i, /^data_?pagamento$/i, /^datapagto$/i, /^data_?baixa$/i, /^datapag$/i];

// ── versão ANTIGA (com o bug) ────────────────────────────────────────────
const pagoAntigo = (row) => {
  const flag = str(pick(row, ...RE_PAGO), 5);
  const dataPag = dateOf(pick(row, ...RE_DATA));
  const pagoFlag = flag != null && ['S', 'SIM'].includes(flag.toUpperCase());
  return pagoFlag || (flag == null && !!dataPag);
};

// ── versão NOVA (corrigida) ──────────────────────────────────────────────
const temColuna = (row, ...res) => Object.keys(row).some((k) => res.some((re) => re.test(k)));
const pagoNovo = (row) => {
  const dataPag = dateOf(pick(row, ...RE_DATA));
  if (temColuna(row, ...RE_PAGO)) {
    const flag = str(pick(row, ...RE_PAGO), 5);
    const aberto = flag == null || ['N', 'NAO', 'NÃO'].includes(flag.toUpperCase());
    return !aberto;
  }
  return !!dataPag;
};

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });

  const [cols] = await my.query('SHOW COLUMNS FROM `movimento`');
  const nomes = cols.map((c) => String(c.Field));
  const colPago = nomes.find((n) => /^(pago|pg|baixado|quitado)$/i.test(n));

  // A BALIZA: critério oficial, direto no SQL.
  const condAberto = `(\`${colPago}\` IS NULL OR \`${colPago}\` = '' OR UPPER(\`${colPago}\`) IN ('N','NAO','NÃO'))`;
  const [[oficial]] = await my.query(
    `SELECT COUNT(*) AS n FROM \`movimento\` WHERE ${condAberto}`,
  );
  console.log(`BALIZA (criterio oficial do sistema): ${nf(oficial.n)} parcelas em aberto`);
  console.log('');

  let n = 0;
  let abertasAntigo = 0;
  let abertasNovo = 0;
  let divergem = 0;
  const exemplos = [];

  const PAGE = 20000;
  for (let off = 0; ; off += PAGE) {
    const [rows] = await my.query({
      sql: `SELECT * FROM \`movimento\` ORDER BY \`REGISTRO\` LIMIT ${PAGE} OFFSET ${off}`,
      timeout: 120_000,
    });
    if (!rows.length) break;
    for (const row of rows) {
      n++;
      const a = pagoAntigo(row);
      const b = pagoNovo(row);
      if (!a) abertasAntigo++;
      if (!b) abertasNovo++;
      if (a !== b) {
        divergem++;
        if (exemplos.length < 6) {
          exemplos.push(
            `REGISTRO=${row.REGISTRO} PAGO=${row.PAGO === null ? '(null)' : `'${row.PAGO}'`} ` +
              `PAGAMENTO=${row.PAGAMENTO ? 'preenchido' : 'vazio'} → antigo=${a ? 'PAGA' : 'aberta'}, novo=${b ? 'PAGA' : 'aberta'}`,
          );
        }
      }
    }
    if (rows.length < PAGE) break;
  }

  console.log(`Linhas processadas:            ${nf(n)}`);
  console.log(`Em aberto pela versao ANTIGA:  ${nf(abertasAntigo)}   (erro: ${nf(Number(oficial.n) - abertasAntigo)})`);
  console.log(`Em aberto pela versao NOVA:    ${nf(abertasNovo)}   (erro: ${nf(Number(oficial.n) - abertasNovo)})`);
  console.log(`Linhas que mudam de veredito:  ${nf(divergem)}`);
  if (exemplos.length) {
    console.log('');
    console.log('Exemplos do que muda:');
    for (const e of exemplos) console.log('  ' + e);
  }

  console.log('');
  console.log('=========================================');
  if (abertasNovo === Number(oficial.n) && abertasAntigo !== Number(oficial.n)) {
    console.log('TESTE PASSOU: a versao nova bate EXATO com o criterio oficial,');
    console.log('e a antiga nao batia. A correcao resolve e nao inventa nada novo.');
    console.log('');
    console.log('PROXIMO PASSO: deploy + rodar o sync do crediario nativo, senao as');
    console.log('linhas ja gravadas continuam erradas no banco.');
  } else if (abertasNovo === Number(oficial.n)) {
    console.log('Versao nova bate com o oficial, mas a antiga tambem batia —');
    console.log('nao havia bug neste conjunto de dados.');
  } else {
    console.log('TESTE FALHOU: a versao nova NAO bate com o criterio oficial.');
    console.log('NAO deployar. A regra ainda esta errada.');
  }

  await my.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
