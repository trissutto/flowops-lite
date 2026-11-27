#!/usr/bin/env node
/**
 * IMPORTA A CAIXA HISTÓRICA DO GIGA (dump final de 28/08/2026) PRO FLOW.
 *
 * O Postgres do Flow nunca teve `giga_caixa_mov` antes de 02/01/2025
 * (`GIGA_MIRROR_FROM=2025-01-01`). Até 27/08 a tela de faturamento mostrava
 * 2024 porque caía no MySQL do Giga ao vivo — que morreu. O dump
 * `gigasistemas21-COMPLETO-2026-08-28.sql.gz` tem a tabela `caixa` inteira
 * (2006 → 2026, 1,65 mi linhas). Este script carrega o que falta.
 *
 * Modos (um por vez):
 *   --dry-run   lê o dump, grava o CSV e imprime contagens por ano. NÃO conecta.
 *   --apply     COPY do CSV numa tabela TEMPORÁRIA + INSERT ... ON CONFLICT
 *               (registro) DO NOTHING em `giga_caixa_mov`, e o diário por
 *               loja/dia em `giga_caixa_diario` só pros dias que não existem.
 *               Tudo numa transação: ou entra inteiro, ou nada.
 *   --verify    conta linhas por ano nas duas tabelas (só leitura).
 *
 * Opções:
 *   --dump <arquivo.sql.gz>   (default: o dump de 28/08 no Documents do dono)
 *   --csv  <arquivo.csv>      (default: ao lado do dump)
 *   --de   YYYY-MM-DD         (default 2000-01-01 — fora: 27 linhas de 1907 e lixo)
 *   --ate  YYYY-MM-DD         (default 2024-12-31 — 2025+ já está no Flow)
 *
 * Conexão: `DATABASE_PUBLIC_URL` (railway run a partir da pasta do runner,
 * que está linkada ao serviço Postgres). `pg` e `pg-copy-streams` vêm do
 * NODE_PATH ou do node_modules da pasta de onde o script é chamado.
 *
 * Formato do dump: mysqldump com INSERT multi-linha — cabeçalho
 * "INSERT INTO `caixa` VALUES" e uma linha "(...)," por registro. Charset
 * do arquivo é UTF-8 (SET NAMES utf8mb4), apesar do DEFAULT CHARSET=latin1
 * das tabelas.
 *
 * Colunas da `caixa` no dump (ordem do CREATE TABLE):
 *   REGISTRO NUMERO CODIGO DATA DATAFEC CLIENTE DESCRICAO GRUPO QUANTIDADE
 *   VALOR DESCONTO VALORTOTAL VALORDESCONTO OPERADOR VENDEDOR TROCADO MARCADO
 *   FORNECEDOR OCULTO SUBGRUPO HORA TRIBUTO NOMECLIENTE OBS_PEDIDO LOJA
 * Sem CODCLIENTE/CPF/VENDEDORA/VENDEDORACODE/FPAG/VALORUNITARIO: viram NULL,
 * igual ao `mapCaixaMovRow` fazia quando a coluna não existia.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const DUMP = opt('--dump', 'C:/Users/User/Documents/FLOW-BACKUP-2026-08-27/gigasistemas21-COMPLETO-2026-08-28.sql.gz');
const CSV = opt('--csv', path.join(path.dirname(DUMP), 'caixa-giga-2000-2024.csv'));
const DE = opt('--de', '2000-01-01');
const ATE = opt('--ate', '2024-12-31');
const MODE = has('--apply') ? 'apply' : has('--verify') ? 'verify' : 'dry-run';

const COLS_DUMP = [
  'REGISTRO', 'NUMERO', 'CODIGO', 'DATA', 'DATAFEC', 'CLIENTE', 'DESCRICAO', 'GRUPO', 'QUANTIDADE',
  'VALOR', 'DESCONTO', 'VALORTOTAL', 'VALORDESCONTO', 'OPERADOR', 'VENDEDOR', 'TROCADO', 'MARCADO',
  'FORNECEDOR', 'OCULTO', 'SUBGRUPO', 'HORA', 'TRIBUTO', 'NOMECLIENTE', 'OBS_PEDIDO', 'LOJA',
];
// Colunas de giga_caixa_mov, na ordem do CSV (synced_at fica no DEFAULT now()).
const COLS_PG = [
  'registro', 'numero', 'controle', 'codigo', 'data', 'data_fec', 'hora', 'descricao', 'quantidade',
  'valor', 'valor_total', 'operador', 'vendedor', 'cliente', 'loja', 'marcado', 'cod_cliente',
  'nome_cliente', 'cpf', 'vendedora', 'vendedora_code', 'fpag', 'obs_pedido', 'valor_unitario',
];

/** Quebra UMA linha "(v1,v2,'txt',NULL,...)," nos valores (null = NULL do MySQL). */
function parseRow(line) {
  let i = line.indexOf('(');
  if (i < 0) return null;
  i++;
  const out = [];
  let cur = '';
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'") {
      // string com escapes do mysqldump: \' \\ \n \r \0 \Z \t \" e '' dobrado
      i++;
      let s = '';
      while (i < line.length) {
        const c = line[i];
        if (c === '\\') {
          const n = line[i + 1];
          s += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n === '0' ? '' : n === 'Z' ? '' : n;
          i += 2;
          continue;
        }
        if (c === "'") {
          if (line[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++;
          break;
        }
        s += c;
        i++;
      }
      out.push(s);
      // pula até a vírgula ou o fecha-parêntese
      while (i < line.length && line[i] !== ',' && line[i] !== ')') i++;
      if (line[i] === ')') break;
      i++; // vírgula
      continue;
    }
    if (ch === ',' ) { out.push(cur === 'NULL' ? null : cur); cur = ''; i++; continue; }
    if (ch === ')') { out.push(cur === 'NULL' ? null : cur); break; }
    cur += ch;
    i++;
  }
  return out;
}

const trimTo = (v, n) => (v == null ? null : String(v).trim().slice(0, n));
const dateOrNull = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !v.startsWith('0000') ? v : null);
const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// NUMERO é FLOAT no MySQL; o dump pode escrever 1.14e7. Inteiro em texto.
const numeroTxt = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : trimTo(v, 20);
};

/** Linha do dump → objeto com as colunas do Postgres (mesma régua do mapCaixaMovRow). */
function mapRow(vals) {
  if (!vals || vals.length !== COLS_DUMP.length) return { erro: `colunas=${vals ? vals.length : 0}` };
  const r = {};
  COLS_DUMP.forEach((c, i) => (r[c] = vals[i]));
  const registro = trimTo(r.REGISTRO, 20);
  if (!registro) return { erro: 'sem REGISTRO' };
  return {
    row: {
      registro,
      numero: numeroTxt(r.NUMERO),
      controle: null,
      codigo: trimTo(r.CODIGO, 14),
      data: dateOrNull(r.DATA),
      data_fec: dateOrNull(r.DATAFEC),
      hora: trimTo(r.HORA, 10),
      descricao: trimTo(r.DESCRICAO, 120),
      quantidade: numOrNull(r.QUANTIDADE),
      valor: numOrNull(r.VALOR),
      valor_total: numOrNull(r.VALORTOTAL),
      operador: trimTo(r.OPERADOR, 30),
      vendedor: trimTo(r.VENDEDOR, 40),
      cliente: trimTo(r.CLIENTE, 80),
      loja: trimTo(r.LOJA, 4),
      marcado: trimTo(r.MARCADO, 4),
      cod_cliente: null,
      nome_cliente: trimTo(r.NOMECLIENTE, 80),
      cpf: null,
      vendedora: null,
      vendedora_code: null,
      fpag: null,
      obs_pedido: trimTo(r.OBS_PEDIDO, 200),
      valor_unitario: null,
    },
  };
}

const csvCell = (v) => {
  if (v == null) return ''; // vazio sem aspas = NULL no COPY CSV
  const s = String(v);
  return /[",\n\r]/.test(s) || s === '' ? `"${s.replace(/"/g, '""')}"` : s;
};

async function dryRun() {
  if (!fs.existsSync(DUMP)) throw new Error(`dump não encontrado: ${DUMP}`);
  const t0 = Date.now();
  const outCsv = fs.createWriteStream(CSV, { encoding: 'utf8' });
  outCsv.write(COLS_PG.join(',') + '\n');
  const rl = readline.createInterface({
    input: fs.createReadStream(DUMP).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  let dentro = false;
  let lidas = 0, gravadas = 0, foraJanela = 0, semData = 0, erros = 0;
  const porAno = new Map();
  const lojas = new Map();
  let somaTotal = 0;
  let registroMin = Infinity, registroMax = -Infinity;
  let pendente = 0;
  for await (const line of rl) {
    if (!dentro) {
      if (line.startsWith('INSERT INTO `caixa` VALUES')) dentro = true;
      continue;
    }
    if (!line.startsWith('(')) {
      // fim do bloco de INSERTs da caixa (outro INSERT, UNLOCK, comentário…)
      if (line.startsWith('INSERT INTO `') && !line.startsWith('INSERT INTO `caixa` VALUES')) dentro = false;
      else if (/^(UNLOCK TABLES|LOCK TABLES|DROP TABLE|CREATE TABLE|\/\*!|--)/.test(line)) dentro = false;
      continue;
    }
    lidas++;
    const m = mapRow(parseRow(line));
    if (m.erro) { erros++; if (erros <= 5) console.error(`linha ${lidas}: ${m.erro}: ${line.slice(0, 120)}`); continue; }
    const row = m.row;
    if (!row.data) { semData++; continue; }
    if (row.data < DE || row.data > ATE) { foraJanela++; continue; }
    const ano = row.data.slice(0, 4);
    porAno.set(ano, (porAno.get(ano) || 0) + 1);
    lojas.set(row.loja, (lojas.get(row.loja) || 0) + 1);
    if (row.valor_total != null && (row.marcado || '').toUpperCase() !== 'SIM') somaTotal += row.valor_total;
    const regN = Number(row.registro);
    if (Number.isFinite(regN)) { registroMin = Math.min(registroMin, regN); registroMax = Math.max(registroMax, regN); }
    gravadas++;
    if (!outCsv.write(COLS_PG.map((c) => csvCell(row[c])).join(',') + '\n')) {
      pendente++;
      await new Promise((res) => outCsv.once('drain', res));
    }
  }
  await new Promise((res) => outCsv.end(res));
  const seg = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`[dry-run] ${seg}s · linhas da caixa no dump: ${lidas} · gravadas no CSV: ${gravadas} · fora da janela ${DE}..${ATE}: ${foraJanela} · sem DATA: ${semData} · erros de parse: ${erros}`);
  console.log(`[dry-run] registro min/max: ${registroMin}/${registroMax} · soma VALORTOTAL (sem MARCADO): R$ ${somaTotal.toFixed(2)}`);
  console.log('[dry-run] por ano:', Array.from(porAno.entries()).sort().map(([a, n]) => `${a}=${n}`).join(' '));
  console.log('[dry-run] por loja:', Array.from(lojas.entries()).sort().map(([l, n]) => `${l}=${n}`).join(' '));
  console.log(`[dry-run] CSV: ${CSV} (${(fs.statSync(CSV).size / 1048576).toFixed(1)} MB)`);
  if (erros > 0) process.exitCode = 2;
}

function conectar() {
  const { Client } = require('pg');
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('sem DATABASE_PUBLIC_URL — rodar com `railway run` na pasta linkada ao Postgres');
  return new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 0 });
}

async function verify(client) {
  const own = !client;
  if (own) { client = conectar(); await client.connect(); await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY'); }
  const mov = await client.query(
    `SELECT extract(year FROM data)::int AS ano, count(*)::int AS n, round(sum(valor_total)::numeric, 2) AS total
       FROM giga_caixa_mov WHERE data IS NOT NULL GROUP BY 1 ORDER BY 1`,
  );
  const dia = await client.query(
    `SELECT extract(year FROM data)::int AS ano, count(*)::int AS n, round(sum(bruto)::numeric, 2) AS total
       FROM giga_caixa_diario GROUP BY 1 ORDER BY 1`,
  );
  const idx = await client.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'giga_caixa_mov' ORDER BY 1`,
  );
  console.log('[verify] giga_caixa_mov por ano:   ' + mov.rows.map((r) => `${r.ano}=${r.n} (R$ ${r.total})`).join(' · '));
  console.log('[verify] giga_caixa_diario por ano: ' + dia.rows.map((r) => `${r.ano}=${r.n} (R$ ${r.total})`).join(' · '));
  console.log('[verify] índices de giga_caixa_mov: ' + idx.rows.map((r) => r.indexname).join(', '));
  if (own) await client.end();
}

async function apply() {
  if (!fs.existsSync(CSV)) throw new Error(`CSV não existe — rode --dry-run antes: ${CSV}`);
  const { from: copyFrom } = require('pg-copy-streams');
  const client = conectar();
  await client.connect();
  const t0 = Date.now();
  console.log(`[apply] ${new Date().toISOString()} início · CSV ${CSV} (${(fs.statSync(CSV).size / 1048576).toFixed(1)} MB) · janela ${DE}..${ATE}`);
  try {
    await client.query('BEGIN');
    // Tabela temporária: morre com a sessão, não aparece pra ninguém.
    await client.query(`CREATE TEMP TABLE caixa_import (LIKE giga_caixa_mov INCLUDING DEFAULTS) ON COMMIT DROP`);
    const copy = client.query(copyFrom(`COPY caixa_import (${COLS_PG.join(', ')}) FROM STDIN WITH (FORMAT csv, HEADER true)`));
    await new Promise((res, rej) => {
      fs.createReadStream(CSV).on('error', rej).pipe(copy).on('error', rej).on('finish', res);
    });
    const n = await client.query('SELECT count(*)::int AS n, min(data) AS d0, max(data) AS d1 FROM caixa_import');
    console.log(`[apply] staging: ${n.rows[0].n} linhas, ${n.rows[0].d0?.toISOString?.().slice(0, 10) || n.rows[0].d0} → ${n.rows[0].d1?.toISOString?.().slice(0, 10) || n.rows[0].d1}`);
    // Guarda: a janela pedida não pode encostar no que já existe no Flow.
    const ja = await client.query(`SELECT count(*)::int AS n FROM giga_caixa_mov WHERE data >= $1 AND data <= $2`, [DE, ATE]);
    console.log(`[apply] giga_caixa_mov já tinha ${ja.rows[0].n} linhas na janela (esperado ~0; ON CONFLICT protege o resto)`);
    const ins = await client.query(
      `INSERT INTO giga_caixa_mov (${COLS_PG.join(', ')})
         SELECT ${COLS_PG.join(', ')} FROM caixa_import
       ON CONFLICT (registro) DO NOTHING`,
    );
    console.log(`[apply] giga_caixa_mov: +${ins.rowCount} linhas (${n.rows[0].n - ins.rowCount} já existiam)`);
    // Diário por loja/dia (base do gráfico e da conta corrente) — só dias que
    // o espelho não tem. Mesma régua do vendaDiariaDoFlow: MARCADO fora,
    // loja com 2 dígitos.
    const dia = await client.query(
      `INSERT INTO giga_caixa_diario (id, loja, data, bruto)
         SELECT 'h' || md5(loja || '|' || data::text), loja, data, bruto
           FROM (
             SELECT lpad(regexp_replace(loja, '[^0-9]', '', 'g'), 2, '0') AS loja,
                    data::date AS data,
                    sum(valor_total)::float8 AS bruto
               FROM caixa_import
              WHERE COALESCE(upper(marcado), '') <> 'SIM' AND loja IS NOT NULL AND data IS NOT NULL
              GROUP BY 1, 2
           ) h
          WHERE NOT EXISTS (SELECT 1 FROM giga_caixa_diario d WHERE d.loja = h.loja AND d.data = h.data)
       ON CONFLICT (id) DO NOTHING`,
    );
    console.log(`[apply] giga_caixa_diario: +${dia.rowCount} dias loja×data`);
    if (has('--ensaio')) {
      // Ensaio: mesma transação, mesmas queries, e no fim ROLLBACK — prova o
      // SQL contra o Postgres real sem gravar um byte.
      await verify(client);
      await client.query('ROLLBACK');
      console.log(`[apply] ENSAIO — ROLLBACK feito, nada gravado (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      return;
    }
    await client.query('COMMIT');
    console.log(`[apply] COMMIT em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    await client.query('ANALYZE giga_caixa_mov');
    await client.query('ANALYZE giga_caixa_diario');
    await verify(client);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[apply] ROLLBACK — nada gravado: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

(async () => {
  if (MODE === 'dry-run') await dryRun();
  else if (MODE === 'verify') await verify();
  else await apply();
})().catch((e) => { console.error(e); process.exit(1); });
