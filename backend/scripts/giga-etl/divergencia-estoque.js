/**
 * DIVERGÊNCIA DE ESTOQUE — Flow × Giga, peça por peça.
 *
 * Responde a pergunta que decide a Fase 2 do descomissionamento: o estoque do
 * Flow já é confiável, ou ainda é uma cópia atrasada?
 *
 * O contexto mudou em 31/07, quando o dono confirmou que NINGUÉM MAIS DIGITA
 * NO WINCRED DESKTOP. Se é assim, o Giga só muda porque o FlowOps escreve
 * nele — e como `decreaseStock`/`increaseStock` já gravam nos DOIS lados, o
 * `wincred_estoque` do Postgres deveria estar correto em tempo real, não
 * atrasado. Este script mede se é verdade.
 *
 * O QUE O RESULTADO SIGNIFICA:
 *   divergência ~0  → o Flow já é dono do estoque de fato; a virada é
 *                     administrativa, não uma migração de dados
 *   divergência alta → existe caminho de escrita que não passa pelo Flow;
 *                     ACHAR ESSE CAMINHO antes de qualquer virada
 *
 * Só faz SELECT nos dois bancos.
 *
 * Uso: railway run --service Postgres -- node scripts/giga-etl/divergencia-estoque.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const norm = (s) => String(s ?? '').trim();
const semZeros = (s) => norm(s).replace(/^0+/, '') || '0';
const chave = (codigo, loja) => `${semZeros(codigo)}|${semZeros(loja)}`;

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

  console.log('Lendo estoque do Giga (ao vivo)...');
  const [gigaRows] = await my.query(
    `SELECT CODIGO, LOJA, COALESCE(ESTOQUE,0) AS ESTOQUE FROM estoque`,
  );
  const giga = new Map();
  for (const r of gigaRows) giga.set(chave(r.CODIGO, r.LOJA), Number(r.ESTOQUE) || 0);
  console.log(`  ${giga.size.toLocaleString('pt-BR')} pares codigo+loja`);

  console.log('Lendo espelho do Flow (wincred_estoque)...');
  const flowRes = await pg.query(`SELECT codigo, loja, COALESCE(estoque,0) AS estoque FROM wincred_estoque`);
  const flow = new Map();
  for (const r of flowRes.rows) flow.set(chave(r.codigo, r.loja), Number(r.estoque) || 0);
  console.log(`  ${flow.size.toLocaleString('pt-BR')} pares codigo+loja`);
  console.log('');

  // Compara pela UNIÃO das chaves: par que existe só de um lado também é
  // divergência — e das piores, porque some da conta em vez de aparecer errado.
  const todas = new Set([...giga.keys(), ...flow.keys()]);

  let iguais = 0;
  let soGiga = 0;
  let soFlow = 0;
  let difer = 0;
  let somaGiga = 0;
  let somaFlow = 0;
  let maiorDif = 0;
  const exemplos = [];

  for (const k of todas) {
    const g = giga.get(k);
    const f = flow.get(k);
    somaGiga += g ?? 0;
    somaFlow += f ?? 0;

    if (g === undefined) {
      soFlow++;
      if (exemplos.length < 15 && (f ?? 0) !== 0) exemplos.push(`${k}  giga=(ausente)  flow=${f}`);
    } else if (f === undefined) {
      soGiga++;
      if (exemplos.length < 15 && g !== 0) exemplos.push(`${k}  giga=${g}  flow=(ausente)`);
    } else if (g === f) {
      iguais++;
    } else {
      difer++;
      maiorDif = Math.max(maiorDif, Math.abs(g - f));
      if (exemplos.length < 15) exemplos.push(`${k}  giga=${g}  flow=${f}  (dif ${f - g})`);
    }
  }

  const comparaveis = iguais + difer;
  const taxa = comparaveis ? (iguais / comparaveis) * 100 : 0;

  console.log('=========================================');
  console.log(`Pares comparaveis:      ${comparaveis.toLocaleString('pt-BR')}`);
  console.log(`  iguais:               ${iguais.toLocaleString('pt-BR')}  (${taxa.toFixed(3)}%)`);
  console.log(`  divergentes:          ${difer.toLocaleString('pt-BR')}`);
  console.log(`So no Giga:             ${soGiga.toLocaleString('pt-BR')}`);
  console.log(`So no Flow:             ${soFlow.toLocaleString('pt-BR')}`);
  console.log('');
  console.log(`SOMA de pecas no Giga:  ${somaGiga.toLocaleString('pt-BR')}`);
  console.log(`SOMA de pecas no Flow:  ${somaFlow.toLocaleString('pt-BR')}`);
  console.log(`Diferenca total:        ${(somaFlow - somaGiga).toLocaleString('pt-BR')} pecas`);
  console.log(`Maior diferenca numa peca: ${maiorDif}`);

  if (exemplos.length) {
    console.log('');
    console.log('Exemplos (codigo|loja):');
    for (const e of exemplos) console.log(`  ${e}`);
  }

  console.log('');
  console.log('=========================================');
  if (taxa >= 99.9 && Math.abs(somaFlow - somaGiga) < comparaveis * 0.001) {
    console.log('VEREDITO: o Flow JA acompanha o Giga em tempo real.');
    console.log('A virada de propriedade do estoque e administrativa, nao');
    console.log('uma migracao de dados.');
  } else {
    console.log('VEREDITO: ha divergencia relevante.');
    console.log('ANTES de virar a propriedade, achar o caminho de escrita que');
    console.log('nao passa pelo Flow. Os exemplos acima sao por onde comecar.');
  }

  await my.end();
  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
