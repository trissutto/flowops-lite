/**
 * VENDA FINALIZADA NO FLOW SEM O DINHEIRO TER ENTRADO.
 *
 * Descoberto em 01/08/2026: venda por link (WhatsApp/Instagram) é lançada
 * MANUALMENTE no PDV. A vendedora manda o link, a cliente diz que pagou, e ela
 * finaliza — baixando estoque e entrando no faturamento.
 *
 * O que torna isso traiçoeiro: em várias recusas o BANCO APROVOU (código 0000,
 * "Transação aprovada com sucesso") e o ANTIFRAUDE da Pagar.me reprovou depois.
 * O valor chega a aparecer no app da cliente, que manda print de boa-fé. A
 * vendedora acredita — e está certa em acreditar, porque naquele instante foi
 * aprovado. A cobrança some dias depois. A loja já entregou.
 *
 * ── POR QUE ESTE SCRIPT FOI REESCRITO (01/08) ─────────────────────────────
 * A 1ª versão casava cobrança↔venda por CPF+valor e contava CADA TENTATIVA
 * de cartão como uma perda. Deu R$ 6.712 onde havia R$ 1.159: a mesma cliente
 * tentando 5× virava 5 prejuízos, e venda paga na maquininha depois do link
 * recusar entrava como perda. Agora o casamento é pela CHAVE EXATA
 * (pagarme_payments.pagarme_order_id ↔ venda) e toda venda é conferida contra
 * TODAS as suas formas de pagamento antes de virar prejuízo.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Dois blocos, porque são dois problemas diferentes:
 *   A) PREJUÍZO CONFIRMADO — link Pagar.me gerado pelo Flow que NÃO foi pago,
 *      e a venda foi finalizada assim mesmo.
 *   B) SEM PROVA NENHUMA — venda online finalizada no braço ("PIX direto" /
 *      "Link externo"): não existe cobrança no gateway pra conferir. Não é
 *      prejuízo provado, é a superfície de risco.
 *
 * Só faz SELECT (Postgres) e GET (Pagar.me). Não escreve em lugar nenhum.
 * A chave da API é lida do banco e NUNCA impressa.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/conferir-vendas-link-nao-pagas.js [dias]
 */

const { Client } = require('pg');

const DIAS = Math.max(1, Math.min(180, Number(process.argv[2]) || 30));
const BRL = (n) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
const pad = (s, n) => String(s ?? '').padEnd(n);

/** Formas de pagamento que provam dinheiro na mão (fora do link). */
const PROVA_REAL = new Set(['dinheiro', 'debito', 'credito', 'pix', 'crediario', 'convenio']);

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  const cfg = await pg.query(`SELECT api_key FROM pagarme_config LIMIT 1`);
  const apiKey = cfg.rows[0]?.api_key;
  if (!apiKey) { console.log('Sem chave da Pagar.me no banco.'); await pg.end(); return; }
  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');

  const desde = new Date(Date.now() - DIAS * 86400_000).toISOString().slice(0, 10);
  console.log(`Conferindo os últimos ${DIAS} dias (desde ${desde}).`);
  console.log('');

  // ── Todas as vendas online finalizadas do período, com seus pagamentos ──
  // Uma venda pode ter várias formas (split) e vários links (retentativa).
  const { rows: vendas } = await pg.query(
    `SELECT s.id, s.store_code, s.total, s.customer_name, s.seller_name,
            s.created_at, (s.stock_decreased_at IS NOT NULL) AS baixou_estoque,
            COALESCE(json_agg(DISTINCT jsonb_build_object(
              'method', p.method, 'valor', p.valor, 'details', p.details
            )) FILTER (WHERE p.id IS NOT NULL), '[]') AS pagamentos,
            COALESCE(json_agg(DISTINCT jsonb_build_object(
              'orderId', g.pagarme_order_id, 'status', g.status, 'valor', g.valor
            )) FILTER (WHERE g.id IS NOT NULL), '[]') AS links
       FROM pdv_sales s
       LEFT JOIN pdv_sale_payments p ON p.sale_id = s.id
       LEFT JOIN pagarme_payments  g ON g.sale_id = s.id
      WHERE s.status = 'finalized' AND s.is_training = false
        AND s.created_at >= $1::date
      GROUP BY s.id
      ORDER BY s.created_at DESC`,
    [desde],
  );

  const parse = (d) => { try { return JSON.parse(d || '{}'); } catch { return {}; } };

  const semProva = [];   // bloco B
  const suspeitas = [];  // bloco A — candidatas, ainda vão ser conferidas ao vivo

  for (const v of vendas) {
    const pagamentos = v.pagamentos || [];
    const online = pagamentos.filter((p) => String(p.method).toLowerCase() === 'venda_online');
    if (!online.length) continue; // venda normal de loja, não é o alvo

    // Pagou de outra forma também? (link recusou → passou na maquininha)
    const outraForma = pagamentos
      .filter((p) => PROVA_REAL.has(String(p.method).toLowerCase()))
      .reduce((s, p) => s + Number(p.valor || 0), 0);

    const temLinkFlow = online.some((p) => parse(p.details).tipo === 'pagarme_link');
    const links = v.links || [];

    if (temLinkFlow) {
      // Algum link dessa venda já consta PAGO no nosso banco? Então entrou.
      if (links.some((l) => String(l.status).toLowerCase() === 'paid')) continue;
      suspeitas.push({ v, links, outraForma });
    } else {
      // 'pix' direto ou 'link' externo: não existe cobrança pra conferir.
      const valor = online.reduce((s, p) => s + Number(p.valor || 0), 0);
      const tipos = [...new Set(online.map((p) => parse(p.details).tipo || '?'))].join('/');
      semProva.push({ v, valor, tipos });
    }
  }

  // ── BLOCO A: confere AO VIVO as suspeitas (poucas) ──
  console.log('══════ A) LINK PAGAR.ME NÃO PAGO — VENDA FINALIZADA MESMO ASSIM ══════');
  console.log('');
  const confirmadas = [];
  for (const s of suspeitas) {
    let pagouAlgum = false;
    let detalhe = null;
    for (const l of s.links) {
      if (!l.orderId) continue;
      try {
        const r = await fetch(`https://api.pagar.me/core/v5/orders/${l.orderId}`, {
          headers: { Authorization: auth },
        });
        if (!r.ok) continue;
        const o = await r.json();
        if (String(o.status).toLowerCase() === 'paid') { pagouAlgum = true; break; }
        const ch = (o.charges || [])[0] || {};
        const tx = ch.last_transaction || {};
        detalhe = {
          status: o.status,
          banco: tx.acquirer_message || null,
          bancoOk: String(tx.acquirer_return_code || '') === '0000',
          antifraude: ch.antifraud_response?.status || null,
        };
      } catch { /* rede: não derruba o relatório */ }
    }
    if (pagouAlgum) continue; // o banco local estava desatualizado, entrou
    confirmadas.push({ ...s, detalhe });
  }

  if (!confirmadas.length) {
    console.log('Nenhuma. Todo link gerado pelo Flow que virou venda foi pago.');
  }
  let prejuizo = 0;
  for (const { v, detalhe, outraForma } of confirmadas) {
    const total = Number(v.total);
    const descoberto = Math.max(0, total - outraForma);
    console.log(
      `${String(v.created_at.toISOString()).slice(0, 10)}  loja ${v.store_code}  ${BRL(total).padStart(13)}  ` +
      `${pad(v.seller_name, 10)} ${String(v.customer_name || '?').slice(0, 28)}`,
    );
    if (detalhe) {
      console.log(`   Pagar.me: ${detalhe.status}${detalhe.antifraude ? ` · antifraude ${detalhe.antifraude}` : ''}`);
      if (detalhe.banco) {
        console.log(`   o banco disse: "${detalhe.banco}"${detalhe.bancoOk ? '  ← por isso a cliente viu o débito' : ''}`);
      }
    }
    if (outraForma > 0) {
      console.log(`   ⚠ mas ${BRL(outraForma)} foi pago por OUTRA forma na mesma venda — descoberto real ${BRL(descoberto)}`);
    }
    console.log(`   venda ${v.id.slice(0, 8)} · estoque ${v.baixou_estoque ? 'BAIXADO ⚠' : 'não baixado'}`);
    console.log('');
    prejuizo += descoberto;
  }
  if (confirmadas.length) {
    console.log(`${confirmadas.length} venda(s) · ${BRL(prejuizo)} descoberto`);
  }

  // ── BLOCO B: superfície de risco ──
  console.log('');
  console.log('══════ B) VENDA ONLINE FINALIZADA SEM NENHUMA PROVA DE PAGAMENTO ══════');
  console.log('  ("PIX direto" e "Link externo" não geram cobrança no gateway —');
  console.log('   ninguém consegue conferir depois. Não é prejuízo provado: é o risco.)');
  console.log('');
  const totalSemProva = semProva.reduce((s, x) => s + x.valor, 0);
  console.log(`  ${semProva.length} vendas · ${BRL(totalSemProva)} em ${DIAS} dias`);
  console.log('');

  const porLoja = new Map();
  for (const x of semProva) {
    const a = porLoja.get(x.v.store_code) || { n: 0, v: 0 };
    a.n++; a.v += x.valor; porLoja.set(x.v.store_code, a);
  }
  console.log('  por loja:');
  for (const [loja, a] of [...porLoja].sort((x, y) => y[1].v - x[1].v)) {
    console.log(`    loja ${pad(loja, 4)} ${String(a.n).padStart(4)} vendas  ${BRL(a.v).padStart(14)}`);
  }
  console.log('');
  console.log('  as 10 maiores:');
  for (const x of [...semProva].sort((a, b) => b.valor - a.valor).slice(0, 10)) {
    console.log(
      `    ${x.v.created_at.toISOString().slice(0, 10)} loja ${pad(x.v.store_code, 3)} ${BRL(x.valor).padStart(13)} ` +
      `${pad(x.tipos, 12)} ${pad(x.v.seller_name, 10)} ${String(x.v.customer_name || '?').slice(0, 24)}`,
    );
  }

  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
