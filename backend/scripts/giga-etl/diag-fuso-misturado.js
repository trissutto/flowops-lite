/**
 * O horário das vendas é SEMPRE UTC, ou há MISTURA?
 *
 * Esta é a pergunta que decide se dá pra consertar por consulta ou se algum
 * dado precisa ser reescrito — e reescrever é irreversível, então não pode ser
 * no chute.
 *
 *   TUDO UTC (consistente)  -> o dado está íntegro. Conserta-se nas CONSULTAS,
 *                              convertendo UTC->Brasília ao agrupar por dia.
 *                              NÃO tocar nos timestamps.
 *   MISTURA                 -> parte do código grava UTC e parte grava
 *                              Brasília. Aí sim há dado torto, e é preciso
 *                              separar qual é qual ANTES de corrigir.
 *
 * O teste é o histograma de horas. Loja abre ~9h e fecha ~22h de Brasília.
 *   Se tudo for UTC, as vendas aparecem entre 12h e 01h (9h+3).
 *   Se tudo fosse Brasília, apareceriam entre 9h e 22h.
 *   Se houver venda nas duas faixas em volume, há mistura — e o buraco
 *   natural da madrugada some.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-fuso-misturado.js
 */

const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  console.log('--- HISTOGRAMA DE HORAS (valor CRU gravado) ---');
  console.log('    loja abre ~9h e fecha ~22h de Brasilia');
  console.log('    se tudo for UTC, o pico fica entre 12h e 01h');
  console.log('');
  const h = await c.query(
    `SELECT EXTRACT(HOUR FROM created_at)::int AS hora, COUNT(*)::int AS n
       FROM pdv_sales
      WHERE status = 'finalized' AND created_at > NOW() - INTERVAL '90 days'
      GROUP BY 1 ORDER BY 1`,
  );
  const total = h.rows.reduce((s, r) => s + r.n, 0);
  const maxN = Math.max(...h.rows.map((r) => r.n), 1);
  for (const r of h.rows) {
    const barra = '#'.repeat(Math.max(1, Math.round((r.n / maxN) * 44)));
    console.log(`  ${String(r.hora).padStart(2, '0')}h ${String(nf(r.n)).padStart(6)} ${barra}`);
  }
  console.log(`  total: ${nf(total)} vendas (90 dias)`);

  // Faixa que SO existe se o valor for Brasilia: 9h-11h. Em UTC isso seria
  // 6h-8h da manha no balcao — loja fechada.
  const cedo = h.rows.filter((r) => r.hora >= 9 && r.hora <= 11).reduce((s, r) => s + r.n, 0);
  // Faixa que SO existe se o valor for UTC: 23h-01h. Em Brasilia isso seria
  // 20h-22h, horario normal; em UTC seria madrugada.
  const tarde = h.rows.filter((r) => r.hora === 23 || r.hora === 0 || r.hora === 1).reduce((s, r) => s + r.n, 0);
  // Madrugada de verdade: 4h-8h no valor cru. Nao existe venda ai em NENHUMA
  // das duas interpretacoes — se houver volume, algo esta muito errado.
  const madrugada = h.rows.filter((r) => r.hora >= 4 && r.hora <= 8).reduce((s, r) => s + r.n, 0);

  console.log('');
  console.log('--- LEITURA ---');
  console.log(`  vendas com hora crua 09h-11h: ${nf(cedo)}  (so faz sentido se o valor for BRASILIA)`);
  console.log(`  vendas com hora crua 23h-01h: ${nf(tarde)}  (so faz sentido se o valor for UTC)`);
  console.log(`  vendas com hora crua 04h-08h: ${nf(madrugada)}  (nao faz sentido em nenhum dos dois)`);

  console.log('');
  console.log('=========================================');
  const pctCedo = total ? (cedo / total) * 100 : 0;
  if (pctCedo < 1) {
    console.log('VEREDITO: NAO ha mistura — o horario e SEMPRE UTC.');
    console.log('');
    console.log('O dado esta INTEGRO e consistente. NAO reescreva os timestamps:');
    console.log('eles nao estao "errados", estao em UTC. Reescrever arriscaria');
    console.log('deslocar duas vezes o que ja estiver certo, e nao tem volta.');
    console.log('');
    console.log('O conserto e nas CONSULTAS: agrupar por dia convertendo pra');
    console.log('Brasilia. Uma unica mudanca no lugar certo arruma o historico');
    console.log('inteiro de uma vez, porque o dado bruto nunca foi perdido.');
  } else {
    console.log('VEREDITO: HA MISTURA. Parte grava UTC e parte grava Brasilia.');
    console.log(`${nf(cedo)} vendas (${pctCedo.toFixed(1)}%) so fazem sentido como Brasilia.`);
    console.log('');
    console.log('AQUI o conserto de consulta NAO basta — mas tambem nao da pra');
    console.log('corrigir em massa: e preciso descobrir QUAL caminho de codigo');
    console.log('gravou cada faixa, e so entao separar. Ate la, nao alterar nada.');
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
