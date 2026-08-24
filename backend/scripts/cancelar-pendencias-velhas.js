/**
 * CANCELAR AS PENDÊNCIAS DE TRANSFERÊNCIA ESQUECIDAS (ordem do dono, 24/08/2026).
 *
 * Ordem pedida e nunca enviada continua descontando o estoque da origem pra
 * sempre — é ela que deixa a Grade por Loja NEGATIVA. Itanhaém aparecia com
 * `-2` em VOGUE-PD PRETO DOURADO 46 e 48: zero na arara e duas ordens abertas
 * desde 29/06, criadas com 3 segundos de diferença (bipe duplo).
 *
 * Pior: as de `tipo=TRANSFERENCIA` NÃO aparecem na fila da loja
 * (`listPendingForStore` filtra REALINHAMENTO), então ninguém ia cancelar na
 * mão o que não vê. Daqui pra frente o cron `PendenciaExpiryCron` faz esta
 * mesma varredura todo dia às 4h35; este script é a limpeza do acumulado.
 *
 * O QUE ELE TOCA: `realignment_status='pending'` SEM CAIXA (`shipment_id IS
 * NULL`) criada há mais de N dias. Cancela — não apaga: o rastro fica e o
 * motivo vai no mesmo campo que a exclusão manual da loja usa.
 *
 * O QUE ELE NÃO TOCA: pendência dentro de caixa ABERTA (a peça já está bipada
 * lá dentro — quem resolve é o "Fechar e enviar"), nada em trânsito, nada
 * recebido, e nenhuma linha de estoque.
 *
 *   railway run --service Postgres node backend/scripts/cancelar-pendencias-velhas.js            # simulação
 *   railway run --service Postgres node backend/scripts/cancelar-pendencias-velhas.js --apply    # grava
 *   ... --dias 30    → janela diferente (default 7, igual à do cron)
 *   ... --loja 01    → só uma loja origem
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const APLICAR = process.argv.includes('--apply');
const argDe = (nome, padrao) => {
  const i = process.argv.indexOf(nome);
  return i > 0 ? String(process.argv[i + 1] || '').trim() : padrao;
};
const DIAS = Math.max(1, Number(argDe('--dias', '7')) || 7);
const lojaArg = argDe('--loja', null);

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const params = [DIAS];
  let filtroLoja = '';
  if (lojaArg) {
    params.push(lojaArg);
    filtroLoja = `AND loja_origem_code = $2`;
  }

  const alvo = (
    await db.query(
      `SELECT id, tipo, codigo_bipado, ref_code, cor, tamanho, qty_origem,
              loja_origem_code, loja_destino_code, created_at, solicitante_nome, mensagem
         FROM transfer_orders
        WHERE realignment_status = 'pending'
          AND shipment_id IS NULL
          AND created_at < now() - ($1 || ' days')::interval
          ${filtroLoja}
        ORDER BY loja_origem_code, created_at`,
      params,
    )
  ).rows;

  console.log(`pendências sem caixa com mais de ${DIAS} dias: ${alvo.length}`);
  if (lojaArg) console.log(`(filtrado na loja origem ${lojaArg})`);

  if (!alvo.length) {
    console.log('\nNada a fazer.');
    await db.end();
    return;
  }

  const porLoja = new Map();
  const porTipo = new Map();
  for (const r of alvo) {
    porLoja.set(r.loja_origem_code, (porLoja.get(r.loja_origem_code) || 0) + 1);
    porTipo.set(r.tipo, (porTipo.get(r.tipo) || 0) + 1);
  }
  console.log('por loja origem:', [...porLoja.entries()].map(([l, n]) => `${l}=${n}`).join(' · '));
  console.log('por tipo:', [...porTipo.entries()].map(([t, n]) => `${t}=${n}`).join(' · '));
  // A ordenação é por loja (pra leitura), então a mais velha da REDE tem que
  // sair do mínimo — `alvo[0]` seria só a mais velha da primeira loja.
  const maisVelha = alvo.reduce(
    (min, r) => (new Date(r.created_at) < new Date(min) ? r.created_at : min),
    alvo[0].created_at,
  );
  console.log('mais velha:', new Date(maisVelha).toISOString().slice(0, 10));

  // BACKUP ANTES DE ESCREVER — é o que permite ressuscitar linha por linha
  // (basta voltar realignment_status pra 'pending' pelos ids salvos aqui).
  const arquivo = path.join(
    __dirname,
    `backup-pendencias-${new Date().toISOString().slice(0, 10)}.json`,
  );
  fs.writeFileSync(arquivo, JSON.stringify({ dias: DIAS, loja: lojaArg, linhas: alvo }, null, 2));
  console.log(`\nbackup: ${arquivo}`);

  if (!APLICAR) {
    console.log('\nSIMULAÇÃO — nada foi gravado. Rode com --apply pra valer.');
    await db.end();
    return;
  }

  // Em transação e pelos IDS FOTOGRAFADOS: se alguém enviar uma dessas peças
  // no meio do caminho, o `AND realignment_status='pending'` protege — a linha
  // que mudou de estado fica de fora.
  const ids = alvo.map((r) => r.id);
  await db.query('BEGIN');
  try {
    const upd = await db.query(
      `UPDATE transfer_orders
          SET realignment_status = 'cancelled',
              realignment_not_found_note = $2
        WHERE id = ANY($1::text[])
          AND realignment_status = 'pending'
          AND shipment_id IS NULL`,
      [ids, `Expirada automaticamente: ${DIAS} dias sem envio`],
    );
    await db.query('COMMIT');
    console.log(`\n${upd.rowCount} pendência(s) cancelada(s).`);
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  await db.end();
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
