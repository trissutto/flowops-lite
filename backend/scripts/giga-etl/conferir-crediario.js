/**
 * O crediário nativo pode ir pra loja amanhã?
 *
 * Contexto: em 25/07 os crediários SUMIRAM do PDV porque a tabela nativa tinha
 * teto de 50 mil linhas. O teto foi elevado, a carga refeita (710k linhas) e a
 * flag CREDIARIO_NATIVE_READS religada em 31/07. Antes de a loja testar com ela
 * ligada, conferir contra o Giga.
 *
 * Duas formas de estragar, e as DUAS são testadas aqui:
 *
 *   A) parcela ABERTA no Giga que sumiu ou consta paga no Flow
 *      → a dívida desaparece do PDV. Foi o incidente de 25/07.
 *
 *   B) parcela PAGA no Giga que consta aberta no Flow
 *      → a cliente é COBRADA DE NOVO por algo que já quitou. Pior que (A):
 *        (A) a loja percebe na hora, (B) só aparece na reclamação da cliente.
 *
 * O mapeamento de "pago" é o suspeito número 1. O sync usa
 * `pago = flagPago==S/SIM || (flag ausente && tem data de pagamento)`. Se a
 * coluna existir com outro vocabulário (1/0, 'P', 'BAIXADO'), TODA parcela
 * quitada vira aberta — cenário (B) em massa.
 *
 * Só faz SELECT nos dois bancos.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/conferir-crediario.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  // ── 1. Como o Giga representa "pago"? ───────────────────────────────────
  const [cols] = await my.query('SHOW COLUMNS FROM `movimento`');
  const nomes = cols.map((c) => c.Field);
  console.log('--- COLUNAS DE movimento ---');
  console.log('  ' + nomes.join(', '));

  const colPago = nomes.find((n) => /^(pago|pg|baixado|quitado)$/i.test(n));
  const colDataPag = nomes.find((n) => /^(pagamento|data_?pagamento|datapagto|data_?baixa|datapag)$/i.test(n));
  const colReg = nomes.find((n) => /^(registro|id)$/i.test(n));
  const colLoja = nomes.find((n) => /^(loja|cod_?loja|filial)$/i.test(n));
  const colValor = nomes.find((n) => /^(valor_?parcela|valorparcela|valor|vlr_?parcela)$/i.test(n));

  console.log('');
  console.log(`  coluna de pago:      ${colPago || '(NENHUMA — o sync vai decidir por data de pagamento)'}`);
  console.log(`  coluna de data pag.: ${colDataPag || '(nenhuma)'}`);
  console.log(`  chave (registro):    ${colReg || '(NENHUMA — mapRow descarta TUDO)'}`);

  if (colPago) {
    const [vals] = await my.query(
      `SELECT \`${colPago}\` AS v, COUNT(*) AS n FROM \`movimento\` GROUP BY \`${colPago}\` ORDER BY n DESC LIMIT 12`,
    );
    console.log('');
    console.log(`  VALORES DISTINTOS de ${colPago}:`);
    for (const r of vals) console.log(`    ${String(r.v === null ? '(null)' : r.v).padEnd(14)} ${nf(r.n)}`);
    // O sync só aceita S/SIM. Qualquer outro vocabulário = quitada vira aberta.
    const aceitos = vals.filter((r) => r.v != null && ['S', 'SIM'].includes(String(r.v).trim().toUpperCase()));
    const rejeitados = vals.filter((r) => r.v != null && !['S', 'SIM', 'N', 'NAO', 'NÃO'].includes(String(r.v).trim().toUpperCase()));
    if (!aceitos.length && vals.some((r) => r.v != null)) {
      console.log('');
      console.log('  *** ALERTA GRAVE: nenhum valor bate com S/SIM que o sync espera.');
      console.log('      TODA parcela quitada vai constar ABERTA no Flow → cliente cobrada 2x.');
    }
    if (rejeitados.length) {
      console.log(`  *** ATENCAO: vocabulario nao previsto: ${rejeitados.map((r) => r.v).join(', ')}`);
    }
  }

  // ── 2. A carga trouxe tudo? ─────────────────────────────────────────────
  console.log('');
  console.log('--- VOLUME ---');
  const [[tot]] = await my.query('SELECT COUNT(*) AS n FROM `movimento`');
  console.log(`  Giga movimento:            ${nf(tot.n)}`);

  if (colReg) {
    const [[dist]] = await my.query(`SELECT COUNT(DISTINCT \`${colReg}\`) AS n FROM \`movimento\``);
    console.log(`  REGISTRO distintos:        ${nf(dist.n)}`);
    if (Number(dist.n) < Number(tot.n)) {
      // createMany usa skipDuplicates: REGISTRO repetido some sem avisar.
      console.log(`  *** ${nf(tot.n - dist.n)} linhas com REGISTRO REPETIDO — skipDuplicates descarta em silencio`);
    }
    const [[vazio]] = await my.query(
      `SELECT COUNT(*) AS n FROM \`movimento\` WHERE \`${colReg}\` IS NULL OR TRIM(\`${colReg}\`)=''`,
    );
    if (Number(vazio.n)) console.log(`  *** ${nf(vazio.n)} linhas SEM registro — mapRow descarta (retorna null)`);
  }

  const flowTot = await pg.query(`SELECT COUNT(*)::int AS n FROM crediario_parcelas WHERE flow_is_source = false`);
  const flowFlow = await pg.query(`SELECT COUNT(*)::int AS n FROM crediario_parcelas WHERE flow_is_source = true`);
  console.log(`  Flow (vindas do Giga):     ${nf(flowTot.rows[0].n)}`);
  console.log(`  Flow (nascidas no Flow):   ${nf(flowFlow.rows[0].n)}`);
  const falta = Number(tot.n) - flowTot.rows[0].n;
  console.log(`  DIFERENCA:                 ${nf(falta)}`);

  // ── 3. O que importa pra loja: as ABERTAS ───────────────────────────────
  console.log('');
  console.log('--- PARCELAS EM ABERTO (o que o PDV mostra) ---');

  let sqlAberto;
  if (colPago) {
    sqlAberto = `(UPPER(TRIM(COALESCE(\`${colPago}\`,''))) NOT IN ('S','SIM'))`;
  } else if (colDataPag) {
    sqlAberto = `(\`${colDataPag}\` IS NULL)`;
  } else {
    sqlAberto = '1=1';
  }

  const [[abGiga]] = await my.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(${colValor ? '`' + colValor + '`' : '0'}),0) AS v
       FROM \`movimento\` WHERE ${sqlAberto}`,
  );
  const abFlow = await pg.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v
       FROM crediario_parcelas WHERE pago = false`,
  );
  console.log(`  Giga em aberto:  ${nf(abGiga.n).padStart(10)}  ${brl(abGiga.v)}`);
  console.log(`  Flow em aberto:  ${nf(abFlow.rows[0].n).padStart(10)}  ${brl(abFlow.rows[0].v)}`);
  const difAb = abFlow.rows[0].n - Number(abGiga.n);
  console.log(`  diferenca:       ${nf(difAb).padStart(10)}  ${brl(abFlow.rows[0].v - abGiga.v)}`);
  if (difAb > 0) {
    console.log('  >> Flow tem MAIS aberto que o Giga = risco de COBRAR DUAS VEZES (cenario B)');
  } else if (difAb < 0) {
    console.log('  >> Flow tem MENOS aberto que o Giga = DIVIDA SUMINDO do PDV (cenario A, o de 25/07)');
  }

  // ── 4. Registro a registro nas ABERTAS do Giga ──────────────────────────
  if (colReg) {
    console.log('');
    console.log('--- CONFERENCIA REGISTRO A REGISTRO (abertas do Giga) ---');
    const [abertas] = await my.query(
      `SELECT \`${colReg}\` AS reg FROM \`movimento\` WHERE ${sqlAberto}`,
    );
    const regs = abertas.map((r) => String(r.reg ?? '').trim()).filter(Boolean);
    console.log(`  ${nf(regs.length)} registros abertos no Giga a verificar`);

    let ausentes = 0;
    let constamPagas = 0;
    const exemplos = [];
    for (let i = 0; i < regs.length; i += 5000) {
      const lote = regs.slice(i, i + 5000);
      const r = await pg.query(
        `SELECT registro, pago FROM crediario_parcelas WHERE registro = ANY($1::text[])`,
        [lote],
      );
      const achados = new Map(r.rows.map((x) => [String(x.registro), x.pago]));
      for (const reg of lote) {
        if (!achados.has(reg)) {
          ausentes++;
          if (exemplos.length < 10) exemplos.push(`${reg} — AUSENTE no Flow`);
        } else if (achados.get(reg) === true) {
          constamPagas++;
          if (exemplos.length < 10) exemplos.push(`${reg} — consta PAGA no Flow, aberta no Giga`);
        }
      }
    }
    console.log(`  ausentes no Flow:        ${nf(ausentes)}`);
    console.log(`  constam pagas no Flow:   ${nf(constamPagas)}`);
    const somem = ausentes + constamPagas;
    if (exemplos.length) {
      console.log('  exemplos:');
      for (const e of exemplos) console.log(`    ${e}`);
    }

    console.log('');
    console.log('=========================================');
    if (somem === 0 && difAb <= 0) {
      console.log('VEREDITO: nenhuma divida aberta do Giga sumiu nem virou paga no Flow.');
      console.log('Pode testar na loja com CREDIARIO_NATIVE_READS=1.');
    } else if (somem === 0 && difAb > 0) {
      console.log('VEREDITO: nada sumiu, MAS o Flow tem mais parcelas abertas que o Giga.');
      console.log('Conferir o mapeamento de "pago" antes de cobrar qualquer cliente.');
    } else {
      console.log(`VEREDITO: NAO LIBERAR. ${nf(somem)} dividas abertas do Giga nao aparecem`);
      console.log('corretamente no Flow — e o mesmo sintoma de 25/07, agora na loja.');
    }
  }

  await my.end();
  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
