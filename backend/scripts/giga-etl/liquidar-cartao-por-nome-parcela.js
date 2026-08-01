/**
 * SEGUNDA PASSADA da liquidação de cartão — casando pelo NOME DA PARCELA.
 *
 * A primeira passada (`liquidar-cartao-vencido.js`) casou pelo nome da FICHA,
 * na tabela `clientes`. Liquidou R$ 1.731.983 e deixou ~R$ 611 mil pra trás.
 *
 * ── POR QUE SOBROU ──
 *
 * Algumas lojas usam uma ficha com NOME DE PESSOA como conta de repasse de
 * cartão. Descoberto em 01/08:
 *
 *   loja 03 cod 2  ficha "SANDRA FERREIRA GUIMARÃES"  → parcelas dizem CREDICARD
 *   loja 03 cod 3  ficha "VANESSA JULÍO SANTOS"       → parcelas dizem VISANET
 *   loja 05 cod 26 ficha "SILVIA MARCONDES..."        → parcelas dizem VISANET
 *   loja 10 cod 1  ficha "NOELY SILVA DE SOYZA"       → parcelas dizem VENDA ONLINE
 *
 * São os códigos 1, 2, 3 — as primeiras fichas criadas na loja — e duas delas
 * têm limite de R$ 99 milhões, que é o jeito antigo de escrever "sem limite".
 * Provavelmente nasceram com o nome de quem cadastrou a loja e viraram conta
 * de repasse depois.
 *
 * A `movimento` tem coluna `NOME` própria, gravada na venda. Ela diz CREDICARD
 * mesmo quando a ficha se chama SANDRA. É o campo confiável — e usá-lo dispensa
 * adivinhar quais fichas foram sequestradas, inclusive as futuras.
 *
 * ── O QUE FICA DE FORA, DE PROPÓSITO ──
 *
 *  · VENDA ONLINE / VENDA ONLINE LOJA / VENDAS ONLINE (R$ 1,4 mi) — é venda do
 *    site. Provavelmente também já recebida via gateway, mas o dono não
 *    confirmou, e R$ 1,4 milhão não se baixa por dedução;
 *  · CONSUMIDOR — venda à vista;
 *  · ASPMI, GREMIO, VINHECARD — não confirmados. ASPMI e GREMIO cheiram a
 *    convênio (dívida real, descontada em folha); VINHECARD apareceu agora e
 *    não foi verificado. Todos são LISTADOS no relatório pro dono decidir.
 *
 * ── SEGURANÇA ──
 *
 * Nasce em simulação. Com --aplicar, grava o estado anterior num JSON ANTES do
 * primeiro UPDATE. E emite a LISTA DE CONFERÊNCIA: cada ficha tocada, com o
 * nome do cliente, quantas parcelas e qual bandeira — pra o dono checar se
 * alguma cliente de verdade entrou junto.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/liquidar-cartao-por-nome-parcela.js
 *   railway run --service Postgres -- node backend/scripts/giga-etl/liquidar-cartao-por-nome-parcela.js --aplicar
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const APLICAR = process.argv.includes('--aplicar');
const LOTE = 500;
const BRL = (n) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

/** Só adquirente/bandeira. Nome EXATO — nunca LIKE (o '%ELO%' de hoje de manhã
 *  casou com MARCELO, MELO, ANGELO, BARCELOS, VELOSO, RABELO...). */
const BANDEIRAS = [
  'CREDICARD', 'VISANET', 'VISA ELECTRON', 'VISAELECTRON',
  'REDESHOP', 'REDE SHOP', 'CIELO', 'CIELODEB',
  'ELO', 'ELO (ANTIGO)', 'AMEX', 'HIPERCARD',
  'SOROCRED', 'CREDSYSTEM', 'SISPUMI', 'SISPUMI - BANCRED CARD',
  'MASTERCARD', 'MAESTRO', 'BANRICOMPRAS', 'GETNET', 'STONE',
];

/** Aparecem no relatório, nunca no UPDATE. */
const NAO_CONFIRMADOS = [
  'VENDA ONLINE', 'VENDA ONLINE LOJA', 'VENDAS ONLINE',
  'CONSUMIDOR', 'CONSUMIDOR 1', 'CONSUMIDOR 2',
  'ASPMI', 'GREMIO', 'GREMIO ITANHAEM', 'VINHECARD', 'RESERVA',
];

const ABERTA =
  `(UPPER(COALESCE(PAGO,'')) IN ('N','NAO','NÃO')` +
  ` OR (UPPER(COALESCE(PAGO,'')) NOT IN ('S','SIM','Y')` +
  `     AND (PAGAMENTO IS NULL OR PAGAMENTO = '0000-00-00')))`;

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST, port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER, password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE, connectTimeout: 20000,
  });
  await my.query('SET SQL_BIG_SELECTS=1');

  console.log(APLICAR ? '⚠  MODO APLICAR — VAI ESCREVER NO GIGA' : '○ modo simulação (use --aplicar pra valer)');
  console.log('');

  const inBand = BANDEIRAS.map(() => '?').join(',');
  const where = `UPPER(TRIM(COALESCE(NOME,''))) IN (${inBand}) AND ${ABERTA} AND VENCIMENTO IS NOT NULL AND VENCIMENTO < CURDATE()`;

  const [resumo] = await my.query(
    `SELECT NOME, COUNT(*) n, SUM(VALORPARCELA) v, MIN(VENCIMENTO) de, MAX(VENCIMENTO) ate
       FROM movimento WHERE ${where} GROUP BY NOME ORDER BY v DESC`,
    BANDEIRAS,
  );
  if (!resumo.length) { console.log('Nada a liquidar — a primeira passada pegou tudo.'); await my.end(); return; }

  let totN = 0, totV = 0;
  console.log('ALVO (bandeiras, pelo NOME da parcela):');
  for (const r of resumo) {
    console.log(`   ${String(r.NOME).padEnd(20)} ${String(r.n).padStart(6)} parc  ${BRL(r.v).padStart(16)}  venc ${String(r.de).slice(0, 10)} a ${String(r.ate).slice(0, 10)}`);
    totN += Number(r.n); totV += Number(r.v);
  }
  console.log(`   ${''.padEnd(20)} ${String(totN).padStart(6)} parc  ${BRL(totV).padStart(16)}  TOTAL`);

  // ── LISTA DE CONFERÊNCIA: de QUAL CLIENTE são essas parcelas? ──
  // É a pergunta do dono: "gere uma lista com nome do cliente e quantidade de
  // parcelas baixadas pra eu conferir se não baixou de algum outro cliente".
  const [porFicha] = await my.query(
    `SELECT COALESCE(c.NOME,'(ficha nao encontrada)') AS ficha, m.LOJA, m.CODCLIENTE,
            m.NOME AS bandeira, COUNT(*) n, SUM(m.VALORPARCELA) v
       FROM movimento m
       LEFT JOIN clientes c ON c.LOJA = m.LOJA AND c.CODIGO = m.CODCLIENTE
      WHERE UPPER(TRIM(COALESCE(m.NOME,''))) IN (${inBand}) AND ${ABERTA.replace(/\b(PAGO|PAGAMENTO)\b/g, 'm.$1')}
        AND m.VENCIMENTO IS NOT NULL AND m.VENCIMENTO < CURDATE()
      GROUP BY c.NOME, m.LOJA, m.CODCLIENTE, m.NOME
      ORDER BY v DESC`,
    BANDEIRAS,
  );
  console.log('');
  console.log('══════ LISTA DE CONFERÊNCIA — de qual ficha sai cada baixa ══════');
  console.log('');
  console.log('FICHA (nome do cliente)              LOJA COD   BANDEIRA        PARCELAS          VALOR');
  for (const r of porFicha) {
    console.log(
      `${String(r.ficha).slice(0, 34).padEnd(36)} ${String(r.LOJA).padEnd(4)} ${String(r.CODCLIENTE).padEnd(5)} ` +
      `${String(r.bandeira).slice(0, 14).padEnd(15)} ${String(r.n).padStart(8)}  ${BRL(r.v).padStart(14)}`,
    );
  }
  console.log('');
  console.log(`${porFicha.length} combinação(ões) ficha × bandeira.`);
  console.log('Toda linha aqui e uma ficha usada como conta de repasse — o nome e da');
  console.log('pessoa, mas a venda e de cartao. Se alguma parecer cliente DE VERDADE,');
  console.log('pare e me avise ANTES de aplicar.');

  // O que NÃO entra, pro dono ver o tamanho do que sobra.
  const inNC = NAO_CONFIRMADOS.map(() => '?').join(',');
  const [fora] = await my.query(
    `SELECT NOME, COUNT(*) n, SUM(VALORPARCELA) v FROM movimento
      WHERE UPPER(TRIM(COALESCE(NOME,''))) IN (${inNC}) AND ${ABERTA}
        AND VENCIMENTO IS NOT NULL AND VENCIMENTO < CURDATE()
      GROUP BY NOME ORDER BY v DESC`,
    NAO_CONFIRMADOS,
  );
  if (fora.length) {
    console.log('');
    console.log('FORA desta liquidação, pro dono decidir:');
    for (const r of fora) console.log(`   ${String(r.NOME).padEnd(20)} ${String(r.n).padStart(6)} parc  ${BRL(r.v)}`);
  }

  if (!APLICAR) {
    console.log('');
    console.log('Simulação. Nada foi escrito.');
    await my.end();
    return;
  }

  // ── REVERSÃO ANTES DE ESCREVER ──
  const [antes] = await my.query(
    `SELECT REGISTRO, CONTROLE, LOJA, CODCLIENTE, NOME, VALORPARCELA, PAGO, PAGAMENTO
       FROM movimento WHERE ${where}`,
    BANDEIRAS,
  );
  const arq = path.join(__dirname, `reversao-cartao-nome-parcela-${antes.length}-linhas.json`);
  fs.writeFileSync(arq, JSON.stringify(antes, null, 1));
  console.log('');
  console.log(`↩ estado anterior salvo em ${arq} (${antes.length} linhas)`);

  let feitas = 0;
  for (let i = 0; i < antes.length; i += LOTE) {
    const ids = antes.slice(i, i + LOTE).map((r) => `'${String(r.REGISTRO).replace(/'/g, '')}'`).join(',');
    const [r] = await my.query({
      sql: `UPDATE movimento SET PAGO='S', PAGAMENTO=VENCIMENTO WHERE REGISTRO IN (${ids}) AND ${ABERTA}`,
      timeout: 120000,
    });
    feitas += r.affectedRows || 0;
    process.stdout.write(`\r  liquidadas ${feitas}/${antes.length}`);
  }
  console.log('');
  console.log(`✓ ${feitas} parcelas liquidadas.`);
  console.log('');
  console.log('AGORA: rode o re-sync pra o espelho do Flow enxergar');
  console.log('  POST /admin/crediario-nativo/sync');

  await my.end();
})().catch((e) => {
  console.log('');
  console.log('ERRO:', e.message);
  process.exit(1);
});
