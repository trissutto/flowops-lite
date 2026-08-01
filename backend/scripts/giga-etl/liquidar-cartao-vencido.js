/**
 * LIQUIDA O CARTÃO QUE JÁ VENCEU e ficou pendurado no crediário.
 *
 * Decisão do dono (01/08/2026). Contexto: no Giga a venda no cartão virava
 * parcela de crediário de uma ficha-operadora (CREDICARD, VISANET, CIELO...) e
 * uma rotina do Wincred DESKTOP liquidava sozinha — débito D+1, crédito D+29.
 * Pararam de abrir o desktop, a rotina parou junto, e ninguém viu. A parcela de
 * cartão mais antiga em aberto venceu em 25/02/2026.
 *
 * ── NASCE EM SIMULAÇÃO ──
 *
 * Sem `--aplicar` nada é escrito. Com `--aplicar`, ANTES de qualquer UPDATE ele
 * grava o estado atual das linhas num arquivo de reversão. Se der errado, esse
 * arquivo desfaz — sem ele, não há como voltar, porque o valor antigo de PAGO
 * é justamente o que o UPDATE apaga.
 *
 * ── O QUE ELE NÃO FAZ, DE PROPÓSITO ──
 *
 *  · não toca em parcela de PESSOA — só nas fichas de operadora, casadas por
 *    NOME. O código não serve: cada loja numera a sua, e o 564 de uma loja é
 *    outra coisa na vizinha;
 *  · não toca no que ainda não venceu — essas liquidam no dia;
 *  · não toca nas 20.100 parcelas cuja ficha não foi encontrada (R$ 3,5 mi).
 *    Pode ser padding de zero no JOIN, e nesse caso há mais cartão escondido
 *    ali — mas "pode ser" não autoriza dar baixa em R$ 3,5 milhões;
 *  · não inventa data de liquidação: usa o VENCIMENTO da própria parcela, que
 *    é o que a rotina do Wincred usava. D+1/D+29 já está embutido nele.
 *
 * ⚠ A data real varia com antecipação, feriado e fim de semana. A verdade é o
 *   extrato da adquirente — isto aqui é a aproximação que limpa o retrovisor
 *   até a conciliação financeira cobrir tudo.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/liquidar-cartao-vencido.js
 *   railway run --service Postgres -- node backend/scripts/giga-etl/liquidar-cartao-vencido.js --aplicar
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const APLICAR = process.argv.includes('--aplicar');
const LOTE = 500;

const BRL = (n) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

// NOME EXATO, nunca LIKE.
//
// A primeira versão disto usava `LIKE '%ELO%'` e afins. O ensaio de 01/08
// mostrou o estrago: casou com MARCELO, MELO, ANGELO, BARCELOS, VELOSO,
// RABELO, VASCONCELOS, SAMELO, HELOISA, ELOISE... mais de 100 PESSOAS REAIS
// entraram na lista de "operadoras". Se tivesse rodado com --aplicar, teria
// dado baixa em dívida de cliente de verdade.
//
// É por isso que este script nasce em simulação e imprime a lista de fichas
// antes de qualquer coisa: pra esse tipo de erro aparecer antes, não depois.
const CARTAO = [
  'CREDICARD', 'VISANET', 'VISA ELECTRON', 'VISAELECTRON',
  'REDESHOP', 'REDE SHOP', 'CIELO', 'CIELODEB',
  'ELO', 'ELO (ANTIGO)', 'AMEX', 'HIPERCARD',
  'SOROCRED', 'CREDSYSTEM', 'SISPUMI', 'SISPUMI - BANCRED CARD',
  'MASTERCARD', 'MAESTRO', 'BANRICOMPRAS', 'GETNET', 'STONE',
];

// Ficam DE FORA e vão pro relatório, pra o dono decidir:
//   GREMIO / GREMIO ITANHAEM → convênio de funcionários, não é adquirente:
//     alguém desconta em folha e paga. Dar baixa por data seria perdoar dívida.
//   ROBERTO SISPUMI → pessoa cujo sobrenome coincide com a financeira.
const DUVIDOSOS = ['GREMIO', 'GREMIO ITANHAEM', 'ROBERTO SISPUMI'];

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST, port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER, password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE, connectTimeout: 20000,
  });

  // A `movimento` tem 710k linhas e o JOIN com `clientes` estoura o
  // MAX_JOIN_SIZE padrão do servidor.
  await my.query('SET SQL_BIG_SELECTS=1');

  console.log(APLICAR ? '⚠  MODO APLICAR — VAI ESCREVER NO GIGA' : '○ modo simulação (use --aplicar pra valer)');
  console.log('');

  // As fichas de operadora, por NOME. Guardamos (LOJA, CODIGO) porque o
  // movimento casa por esses dois — o codigo sozinho colide entre lojas.
  const inNomes = CARTAO.map(() => '?').join(',');
  const [fichas] = await my.query(
    `SELECT LOJA, CODIGO, NOME FROM clientes
      WHERE UPPER(TRIM(COALESCE(NOME,''))) IN (${inNomes})`,
    CARTAO,
  );

  // Os duvidosos só aparecem no relatório — nunca entram no UPDATE.
  const [dub] = await my.query(
    `SELECT c.NOME, COUNT(*) AS n, SUM(m.VALORPARCELA) AS v
       FROM clientes c JOIN movimento m ON m.LOJA = c.LOJA AND m.CODCLIENTE = c.CODIGO
      WHERE UPPER(TRIM(COALESCE(c.NOME,''))) IN (${DUVIDOSOS.map(() => '?').join(',')})
        AND (m.PAGAMENTO IS NULL OR m.PAGAMENTO = '0000-00-00')
      GROUP BY c.NOME`,
    DUVIDOSOS,
  );
  if (!fichas.length) {
    console.log('Nenhuma ficha de operadora encontrada — nada a fazer.');
    await my.end();
    return;
  }
  console.log(`Fichas de operadora (nome EXATO): ${fichas.length}`);
  const porNome = {};
  for (const f of fichas) porNome[f.NOME] = (porNome[f.NOME] || 0) + 1;
  console.log(`  ${Object.entries(porNome).map(([n, q]) => `${n}(${q})`).join(' · ')}`);

  if (dub.length) {
    console.log('');
    console.log('FORA da liquidação, pro dono decidir:');
    for (const d of dub) {
      console.log(`  ${String(d.NOME).padEnd(20)} ${String(d.n).padStart(6)} parc · ${BRL(d.v)}`);
    }
    console.log('  (convênio se paga por folha, não por data de adquirente)');
  }

  // Alvo: parcela dessas fichas, ABERTA pelo criterio de common/crediario-pago,
  // e ja vencida.
  const pares = fichas.map((f) => `(LOJA='${String(f.LOJA).replace(/'/g, '')}' AND CODCLIENTE='${String(f.CODIGO).replace(/'/g, '')}')`).join(' OR ');
  const aberta =
    `(UPPER(COALESCE(PAGO,'')) IN ('N','NAO','NÃO')` +
    ` OR (UPPER(COALESCE(PAGO,'')) NOT IN ('S','SIM','Y')` +
    `     AND (PAGAMENTO IS NULL OR PAGAMENTO = '0000-00-00')))`;
  const where = `(${pares}) AND ${aberta} AND VENCIMENTO IS NOT NULL AND VENCIMENTO < CURDATE()`;

  const [resumo] = await my.query(
    `SELECT COUNT(*) AS n, SUM(VALORPARCELA) AS v,
            MIN(VENCIMENTO) AS de, MAX(VENCIMENTO) AS ate
       FROM movimento WHERE ${where}`,
  );
  const R = resumo[0];
  console.log('');
  console.log(`ALVO: ${R.n} parcelas · ${BRL(R.v)} · vencimentos de ${String(R.de).slice(0, 10)} a ${String(R.ate).slice(0, 10)}`);

  if (!Number(R.n)) { await my.end(); return; }

  // Confere que nao pegamos pessoa por engano.
  // `where` usa colunas sem prefixo; qualifica pra não ficar ambíguo no JOIN.
  const whereM = where.replace(/\b(LOJA|CODCLIENTE|PAGO|PAGAMENTO|VENCIMENTO)\b/g, 'm.$1');
  const [amostra] = await my.query(
    `SELECT m.REGISTRO, m.LOJA, m.CODCLIENTE, c.NOME, m.VENCIMENTO, m.VALORPARCELA
       FROM movimento m LEFT JOIN clientes c ON c.LOJA = m.LOJA AND c.CODIGO = m.CODCLIENTE
      WHERE ${whereM} ORDER BY m.VENCIMENTO LIMIT 8`,
  );
  console.log('');
  console.log('AMOSTRA (confira que sao todas operadoras, nenhuma pessoa):');
  for (const a of amostra) {
    console.log(`  reg=${a.REGISTRO} loja=${a.LOJA} cod=${a.CODCLIENTE} ${String(a.NOME || '?').padEnd(16)} venc=${String(a.VENCIMENTO).slice(0, 10)} ${BRL(a.VALORPARCELA)}`);
  }

  if (!APLICAR) {
    console.log('');
    console.log('Simulação. Nada foi escrito. Pra aplicar de verdade:');
    console.log('  railway run --service Postgres -- node backend/scripts/giga-etl/liquidar-cartao-vencido.js --aplicar');
    await my.end();
    return;
  }

  // ── ARQUIVO DE REVERSAO, ANTES DE ESCREVER ──
  // Sem isso a operacao e irreversivel: o valor antigo de PAGO some no UPDATE.
  const [antes] = await my.query(
    `SELECT REGISTRO, CONTROLE, LOJA, CODCLIENTE, PAGO, PAGAMENTO FROM movimento WHERE ${where}`,
  );
  const arq = path.join(__dirname, `reversao-cartao-${antes.length}-linhas.json`);
  fs.writeFileSync(arq, JSON.stringify(antes, null, 1));
  console.log('');
  console.log(`↩ estado anterior salvo em ${arq} (${antes.length} linhas)`);

  // Em lotes, por REGISTRO — o pool do Giga pendura com query grande demais.
  let feitas = 0;
  for (let i = 0; i < antes.length; i += LOTE) {
    const lote = antes.slice(i, i + LOTE);
    const ids = lote.map((r) => `'${String(r.REGISTRO).replace(/'/g, '')}'`).join(',');
    const [r] = await my.query({
      // PAGAMENTO = o proprio VENCIMENTO: e a data que a rotina do Wincred
      // usava. Nao inventa data nova nem usa hoje, que jogaria meses de
      // recebimento pra dentro do mes atual e sujaria o fechamento.
      sql: `UPDATE movimento SET PAGO='S', PAGAMENTO=VENCIMENTO
             WHERE REGISTRO IN (${ids}) AND ${aberta}`,
      timeout: 120000,
    });
    feitas += r.affectedRows || 0;
    process.stdout.write(`\r  liquidadas ${feitas}/${antes.length}`);
  }
  console.log('');
  console.log(`✓ ${feitas} parcelas liquidadas.`);
  console.log('');
  console.log('AGORA: rode o re-sync pra o espelho do Flow enxergar');
  console.log('  POST /admin/crediario-nativo/sync  (ou o botao em /retaguarda/wincred-mirror)');

  await my.end();
})().catch((e) => {
  console.log('');
  console.log('ERRO:', e.message);
  process.exit(1);
});
