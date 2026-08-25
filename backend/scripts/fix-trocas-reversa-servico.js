/**
 * CORRIGE OS CÓDIGOS DE REVERSA DO TIPO ERRADO (25/08/2026).
 *
 * ── O QUE ACONTECEU ──
 * A reversa automática saía como PRÉ-POSTAGEM COMUM de papéis invertidos
 * (serviço 03298 PAC CONTRATO AG, `logisticaReversa: N`). Ela nasce VÁLIDA na
 * API dos Correios — `statusAtual 2 Pré-postado`, rastreio "Etiqueta emitida" —
 * mas o BALCÃO RECUSA: a cliente ouve "esse código não existe".
 *
 * Medido em produção: 19 trocas nesse estado, todas avisadas por e-mail em
 * 25/08 às 20h15. Luzia (troca 23) foi recusada na agência às 21h53 do dia
 * 24/08 e postou 27 minutos depois com um código reverso DE VERDADE que a
 * loja gerou na mão, por fora do sistema. Esse chegou e foi entregue.
 *
 * O código passou a nascer certo (03301 PAC REVERSO + `logisticaReversa: S`,
 * que emite AUTORIZAÇÃO DE POSTAGEM e vale 90 dias). Este script cuida do
 * PASSIVO: descarta o código velho — que não serve pra nada — pro cron
 * `reversasPendentes` gerar o novo pelo caminho já corrigido e
 * `avisosReversaPendentes` avisar a cliente de novo.
 *
 * NÃO toca em troca já postada/recebida, nem em código que JÁ é reverso.
 *
 *   railway link --project heroic-mercy --service flowops-lite   (pega CORREIOS_*)
 *   node backend/scripts/fix-trocas-reversa-servico.js           (--aplicar pra valer)
 */
const path = require('path');
const { Client } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
const axios = require(path.join(__dirname, '..', 'node_modules', 'axios'));

const APLICAR = process.argv.includes('--aplicar');
const ABERTAS = ['aguardando_postagem', 'solicitada', 'aguardando_envio_cliente'];

async function tokenCorreios() {
  const base = 'https://api.correios.com.br';
  const basic = Buffer.from(
    `${process.env.CORREIOS_API_USER}:${process.env.CORREIOS_API_TOKEN}`,
  ).toString('base64');
  const r = await axios.post(
    `${base}/token/v1/autentica/cartaopostagem`,
    { numero: process.env.CORREIOS_CARTAO_POSTAGEM },
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' }, validateStatus: () => true },
  );
  if (!r.data?.token) throw new Error(`auth Correios falhou: HTTP ${r.status}`);
  return { base, headers: { Authorization: `Bearer ${r.data.token}` } };
}

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  const { base, headers } = await tokenCorreios();

  const { rows } = await db.query(
    `SELECT id, numero, status, reversa_codigo, customer_name
       FROM troca_solicitacoes
      WHERE reversa_codigo IS NOT NULL
        AND status = ANY($1::text[])
      ORDER BY numero`,
    [ABERTAS],
  );
  console.log(`${rows.length} troca(s) aberta(s) com código de reversa\n`);

  let trocados = 0;
  let jaCertos = 0;
  for (const t of rows) {
    const r = await axios.get(`${base}/prepostagem/v2/prepostagens`, {
      params: { codigoObjeto: t.reversa_codigo },
      headers,
      validateStatus: () => true,
      timeout: 20000,
    });
    const it = r.data?.itens?.[0];
    const ehReversa = String(it?.logisticaReversa || '').toUpperCase() === 'S';
    const rotulo = `T${String(t.numero).padStart(4, '0')} ${t.reversa_codigo} (${String(t.customer_name || '').slice(0, 22)})`;

    if (!it) {
      console.log(`  ?  ${rotulo} — não achei nos Correios, deixo quieto`);
      continue;
    }
    if (ehReversa) {
      jaCertos++;
      console.log(`  ok ${rotulo} — já é logística reversa`);
      continue;
    }

    trocados++;
    console.log(`  ✗  ${rotulo} — ${it.descStatusAtual} / serviço ${it.codigoServico} — NÃO vale no balcão`);
    if (!APLICAR) continue;

    await db.query(
      `UPDATE troca_solicitacoes
          SET reversa_codigo = NULL, reversa_prazo = NULL,
              reversa_enviada_at = NULL, reversa_lembrete_at = NULL
        WHERE id = $1`,
      [t.id],
    );
    await db.query(
      `INSERT INTO troca_eventos (id, troca_id, tipo, descricao, user_name, created_at)
       VALUES (gen_random_uuid(), $1, 'reversa', $2, 'automático (correção)', NOW())`,
      [
        t.id,
        `Código ${t.reversa_codigo} descartado: saiu como pré-postagem comum (serviço ${it.codigoServico}), ` +
          `que a agência dos Correios recusa. Um código de logística reversa de verdade será gerado e reenviado.`,
      ],
    );
  }

  console.log(
    `\n${jaCertos} já corretos · ${trocados} descartados` +
      (APLICAR ? ' e liberados pro cron regerar (roda no minuto 15 de cada hora, 10 por ciclo)' : ' — rodada SECA, use --aplicar'),
  );
  await db.end();
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
