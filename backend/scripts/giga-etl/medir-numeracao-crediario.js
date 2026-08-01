/**
 * A faixa alta cabe? Medição de REGISTRO e CONTROLE no `movimento` do Giga.
 *
 * Para o Flow passar a numerar as parcelas de crediário (hoje quem numera é o
 * Giga, com MAX+1 FOR UPDATE), a proposta é reservar uma faixa alta pro Flow —
 * o mesmo truque que o pedido do ecommerce já usa (faixa 950 milhões). Só que
 * isso só funciona se:
 *
 *   1. a coluna aguentar o número (INT com sinal estoura em 2.147.483.647);
 *   2. a faixa escolhida estiver MUITO acima do que o Giga já usou, pra nunca
 *      colidir com um MAX+1 dele;
 *   3. os valores atuais forem realmente numéricos — se houver texto no meio,
 *      MAX() mente e a faixa "livre" pode não estar livre.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-numeracao-crediario.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');

// Tetos dos tipos inteiros do MySQL, com e sem sinal.
const TETOS = {
  tinyint: [127, 255],
  smallint: [32767, 65535],
  mediumint: [8388607, 16777215],
  int: [2147483647, 4294967295],
  integer: [2147483647, 4294967295],
  bigint: [9223372036854775807, 18446744073709551615],
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
  const info = {};
  for (const c of cols) info[String(c.Field).toUpperCase()] = c;

  for (const nome of ['REGISTRO', 'CONTROLE']) {
    const c = info[nome];
    console.log('');
    console.log('=== ' + nome + ' ===');
    if (!c) {
      console.log('  (coluna nao existe)');
      continue;
    }
    const tipo = String(c.Type);
    console.log(`  tipo:        ${tipo}${c.Null === 'YES' ? ' (aceita NULL)' : ''}`);

    const base = tipo.toLowerCase().split('(')[0].trim();
    const unsigned = /unsigned/i.test(tipo);
    const teto = TETOS[base] ? TETOS[base][unsigned ? 1 : 0] : null;
    const ehTexto = /char|text/i.test(base);

    if (teto) console.log(`  teto do tipo: ${nf(teto)}`);
    else if (ehTexto) console.log('  teto do tipo: (texto — sem teto numerico, mas ordena como TEXTO)');

    // CAST pra numero: se a coluna for texto, MAX() lexicografico mente
    // ('9' > '10'). O CAST dá o maior valor REAL.
    const [[m]] = await my.query(
      `SELECT MAX(CAST(\`${nome}\` AS UNSIGNED)) AS mx,
              MIN(CAST(\`${nome}\` AS UNSIGNED)) AS mn,
              COUNT(*) AS n,
              COUNT(DISTINCT \`${nome}\`) AS distintos
         FROM \`movimento\``,
    );
    console.log(`  menor:       ${nf(m.mn)}`);
    console.log(`  MAIOR:       ${nf(m.mx)}`);
    console.log(`  linhas:      ${nf(m.n)}   distintos: ${nf(m.distintos)}`);

    // Valor não-numérico quebra a premissa toda.
    const [[naoNum]] = await my.query(
      `SELECT COUNT(*) AS n FROM \`movimento\`
        WHERE \`${nome}\` IS NOT NULL AND TRIM(\`${nome}\`) <> ''
          AND \`${nome}\` NOT REGEXP '^[0-9]+$'`,
    );
    if (Number(naoNum.n)) {
      console.log(`  *** ${nf(naoNum.n)} valores NAO NUMERICOS — MAX+1 e faixa alta ficam sem sentido`);
    }

    if (teto) {
      const folga = teto - Number(m.mx);
      console.log(`  folga ate o teto: ${nf(folga)}`);
      const CANDIDATA = 900_000_000;
      if (teto >= CANDIDATA && Number(m.mx) < CANDIDATA) {
        console.log(`  >> faixa 900.000.000 CABE e esta ${nf(CANDIDATA - Number(m.mx))} acima do maior em uso`);
      } else if (teto < CANDIDATA) {
        console.log(`  >> faixa 900.000.000 NAO CABE neste tipo (teto ${nf(teto)}).`);
        // Metade do que sobra: longe do uso atual, longe do estouro.
        const sugerida = Math.floor((Number(m.mx) + teto) / 2);
        console.log(`     alternativa: comecar em ${nf(sugerida)} (meio do caminho ate o teto)`);
      } else {
        console.log('  >> o Giga JA passou de 900.000.000 — escolher outra faixa');
      }
    }
  }

  // O CONTROLE agrupa as parcelas da mesma compra: quantas por compra, em média
  // e no pior caso? Define o tamanho do lote que o outbox vai replicar de uma vez.
  const ctl = info['CONTROLE'];
  if (ctl) {
    const [[g]] = await my.query(
      `SELECT AVG(c) AS media, MAX(c) AS maior FROM (
         SELECT COUNT(*) AS c FROM \`movimento\` GROUP BY \`CONTROLE\`
       ) t`,
    );
    console.log('');
    console.log('=== PARCELAS POR COMPRA (agrupado por CONTROLE) ===');
    console.log(`  media: ${Number(g.media || 0).toFixed(2)}   maior: ${nf(g.maior)}`);
  }

  await my.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
