/**
 * Quem são as maiores exposições da rede, com nome e origem da dívida.
 *
 * Complementa `medir-exposicao-rede.js`, que mostrava só CPF mascarado. Aqui
 * sai quem é, em que loja nasceu, quanto deve de crediário e de marcado, e
 * desde quando — porque "deve R$ 63 mil com limite de R$ 106" pode ser fraude,
 * pode ser cadastro velho, e pode ser um convênio lançado no nome errado. As
 * três exigem ações opostas.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/quem-deve-mais.js [quantos]
 */

const { Client } = require('pg');

const TOP = Math.max(1, Math.min(50, Number(process.argv[2]) || 10));
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const q = await c.query(
    `WITH ficha AS (
       SELECT regexp_replace(COALESCE(cpf,''),'\\D','','g') AS cpf,
              loja, codigo, COALESCE(limite_compras,0)::float AS limite,
              nome, fone_cel, synced_at
         FROM giga_clientes
        WHERE regexp_replace(COALESCE(cpf,''),'\\D','','g') <> ''
     ),
     cred AS (
       SELECT f.cpf, COALESCE(SUM(p.valor_parcela),0)::float AS v,
              COUNT(*)::int AS parcelas,
              MIN(p.vencimento) AS mais_antiga,
              COUNT(*) FILTER (WHERE p.vencimento < CURRENT_DATE)::int AS vencidas
         FROM ficha f JOIN crediario_parcelas p
           ON p.loja = f.loja AND p.cod_cliente = f.codigo
          AND p.pago = false AND p.cancelado = false
        GROUP BY 1
     ),
     marc AS (
       SELECT f.cpf, COALESCE(SUM(m.valor_total),0)::float AS v, COUNT(*)::int AS pecas
         FROM ficha f JOIN marcados m
           ON m.store_code = f.loja AND m.cod_cliente = f.codigo
          AND m.status = 'ativo' AND m.is_training = false
        GROUP BY 1
     ),
     pessoa AS (
       SELECT cpf, MAX(limite) AS limite,
              (ARRAY_AGG(nome ORDER BY synced_at))[1] AS nome,
              (ARRAY_AGG(fone_cel ORDER BY synced_at))[1] AS fone,
              (ARRAY_AGG(loja ORDER BY synced_at))[1] AS loja_origem,
              STRING_AGG(DISTINCT loja, ', ' ORDER BY loja) AS lojas
         FROM ficha GROUP BY cpf
     )
     SELECT p.*, COALESCE(c.v,0) AS cred, COALESCE(c.parcelas,0) AS parcelas,
            c.mais_antiga, COALESCE(c.vencidas,0) AS vencidas,
            COALESCE(m.v,0) AS marc, COALESCE(m.pecas,0) AS pecas,
            COALESCE(c.v,0)+COALESCE(m.v,0) AS exposicao
       FROM pessoa p
       LEFT JOIN cred c ON c.cpf = p.cpf
       LEFT JOIN marc m ON m.cpf = p.cpf
      WHERE COALESCE(c.v,0)+COALESCE(m.v,0) > 0
      ORDER BY 10 DESC LIMIT $1`,
    [TOP],
  );

  for (const r of q.rows) {
    console.log('');
    console.log('─'.repeat(72));
    console.log(`  ${r.nome || '(sem nome)'}`);
    console.log(`  CPF ${r.cpf}   fone ${r.fone || '—'}`);
    console.log(`  nasceu na loja ${r.loja_origem} · aparece em: ${r.lojas}`);
    console.log('');
    console.log(`  LIMITE cadastrado:  ${brl(r.limite).padStart(16)}`);
    console.log(`  crediario aberto:   ${brl(r.cred).padStart(16)}   ${r.parcelas} parcela(s), ${r.vencidas} vencida(s)`);
    if (r.mais_antiga) console.log(`    vencimento mais antigo: ${String(r.mais_antiga).slice(0, 15)}`);
    console.log(`  marcados ativos:    ${brl(r.marc).padStart(16)}   ${r.pecas} peca(s)`);
    console.log(`  EXPOSICAO:          ${brl(r.exposicao).padStart(16)}`);
    const x = Number(r.limite) > 0 ? (Number(r.exposicao) / Number(r.limite)) : null;
    if (x) console.log(`  >> ${x.toFixed(0)}x o limite cadastrado`);
    else console.log('  >> SEM limite cadastrado');
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
