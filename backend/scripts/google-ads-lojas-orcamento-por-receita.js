/**
 * ORÇAMENTO PROPORCIONAL À RECEITA REAL DA LOJA — conta LOJAS FÍSICAS.
 * Só LÊ (Postgres). Não escreve em lugar nenhum; a saída é a tabela pronta pra
 * colar em `google-ads-lojas-orcamento.js`, que é quem aplica.
 *
 * ── POR QUE A RÉGUA É A RECEITA, E NÃO O QUE O GOOGLE DIZ ──
 *
 * 🚨 A "visita à loja" do Google MENTE nesta rede. Medido em 13/09: Anália
 * Franco era a PIOR loja (R$ 7.454 em 10 dias, 20 cupons) e o Google a
 * ranqueava em 2º lugar; Sorocaba era a PRIMEIRA em receita (R$ 36.241) e
 * aparecia em 9º. A métrica é modelada por densidade populacional — mede onde
 * tem gente, não onde tem venda. (E desde 05/09 ela nem publica mais.)
 *
 * A rede tem a verdade em casa: quanto cada loja vendeu, no PDV, ontem. É essa
 * a régua. Este script cruza o gasto do Google por praça com a receita real da
 * loja daquela praça e diz onde está sobrando e onde está faltando verba.
 *
 * ── A CORREÇÃO DE ITANHAÉM ──
 *
 * Ordem do dono: Itanhaém entra com METADE da receita. A loja vende linhas que
 * o anúncio plus size não traz — infantil, masculino, moda tamanho menor. Contar
 * a receita cheia mandaria verba de plus size atrás de venda que não é de plus
 * size. Não é penalidade: é tirar da conta o que o anúncio não causou.
 *
 * ── NADA DE API DO GOOGLE AQUI ──
 *
 * O gasto sai do espelho `google_ads_gasto_dia`, não da API. Dois motivos: o
 * token é nível Explorer (~2.880 operações/dia, compartilhadas entre leitura e
 * escrita) e estourar a cota trava o resto do trabalho; e o espelho é
 * exatamente o mesmo número, já coletado de hora em hora.
 * ⚠️ NÃO use a coluna `conversoes` do espelho pra nada recente: os últimos ~3
 * dias vêm subnotificados por recência de coleta. Gasto e impressão não sofrem.
 *
 *   railway run --service Postgres node backend/scripts/google-ads-lojas-orcamento-por-receita.js
 *   $env:DIAS="60"; railway run --service Postgres node ...
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const CONTA = '9564998046';
const DIAS = Number(process.env.DIAS || 30);
/** Fator da receita de Itanhaém — ver o cabeçalho. */
const FATOR_ITANHAEM = 0.5;
/** Piso por praça: abaixo disso a campanha não junta dado pra aprender. */
const PISO_DIARIO = 15;

/**
 * Loja → campanha. Escrito à mão e conferido contra os dois lados: o
 * `codigoFlow` de `ecommerce/src/data/lojas.json` e o nome exato da campanha na
 * conta. Não deduzo por regex — errar aqui manda a verba de uma praça pra outra.
 */
const LOJAS = [
  { code: '01', cidade: 'Itanhaém', campanha: 'ITANHAÉM PMax 27.08.25 [Petter]' },
  { code: '02', cidade: 'Santos', campanha: 'SANTOS PMax 27.08.25 [Petter]' },
  { code: '03', cidade: 'Vinhedo', campanha: 'VINHEDO PMax 27.08.25 [Petter]' },
  { code: '04', cidade: 'Indaiatuba', campanha: 'INDAIATUBA PMax 27.08.25 [Petter]' },
  { code: '05', cidade: 'Piracicaba', campanha: 'PIRACICABA PMax 27.08.25 [Petter]' },
  { code: '06', cidade: 'Sorocaba', campanha: 'SOROCABA PMax 27.08.25 [Petter]' },
  { code: '07', cidade: 'Campinas', campanha: 'CAMPINAS PMax 27.08.25 [Petter]' },
  { code: '08', cidade: 'São José dos Campos', campanha: 'SÃO JOSÉ DOS CAMPOS PMax 27.08.25 [Petter]' },
  { code: '10', cidade: 'Jundiaí', campanha: 'JUNDIAÍ PMax 27.08.25 [Petter]' },
  { code: '11', cidade: 'Limeira', campanha: 'LIMEIRA PMax 27.08.25 [Petter]' },
  { code: '14', cidade: 'Praia Grande', campanha: 'PRAIA GRANDE PMax 27.08.25 [Petter]' },
  { code: '15', cidade: 'Moema', campanha: 'MOEMA PMax 27.08.25 [Petter]' },
  { code: '17', cidade: 'Suzano', campanha: 'SUZANO PMax 27.08.25 [Petter]' },
  { code: '18', cidade: 'Anália Franco', campanha: 'ANÁLIA FRANCO PMax 01.06.26 [Petter]' },
];

const brl = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  /* RECEITA por loja. `giga_caixa_mov` é a espinha dos relatórios de venda da
   * rede — a mesma fonte do faturamento e da DRE. O nome é herança do ERP
   * morto; hoje quem alimenta é o próprio Flow. */
  const { rows: receita } = await db.query(
    `SELECT loja, ROUND(SUM(COALESCE(valor_total, 0))::numeric, 2) AS receita
       FROM giga_caixa_mov
      WHERE data >= CURRENT_DATE - $1::int
        AND loja IS NOT NULL
      GROUP BY loja`,
    [DIAS],
  );
  const porLoja = new Map(receita.map((r) => [String(r.loja).padStart(2, '0'), Number(r.receita)]));

  /* GASTO por campanha, do espelho. */
  const { rows: gasto } = await db.query(
    `SELECT campanha_nome, ROUND(SUM(gasto)::numeric, 2) AS gasto, COUNT(DISTINCT dia) AS dias
       FROM google_ads_gasto_dia
      WHERE conta_id = $1 AND dia >= CURRENT_DATE - $2::int
      GROUP BY campanha_nome`,
    [CONTA, DIAS],
  );
  const porCampanha = new Map(gasto.map((g) => [g.campanha_nome, { gasto: Number(g.gasto), dias: Number(g.dias) }]));
  await db.end();

  /* ── A CONTA ─────────────────────────────────────────────────────────── */
  const linhas = LOJAS.map((l) => {
    const rec = porLoja.get(l.code) || 0;
    const fator = l.code === '01' ? FATOR_ITANHAEM : 1;
    const g = porCampanha.get(l.campanha) || { gasto: 0, dias: DIAS };
    return {
      ...l,
      receita: rec,
      receitaAjustada: rec * fator,
      fator,
      gasto: g.gasto,
      diaAtual: g.dias ? g.gasto / g.dias : 0,
    };
  });

  const somaAjustada = linhas.reduce((s, l) => s + l.receitaAjustada, 0);
  const mediaGasta = linhas.reduce((s, l) => s + l.diaAtual, 0);

  if (!somaAjustada) throw new Error('receita zerada no período — confira a tabela giga_caixa_mov');
  if (!mediaGasta) throw new Error('gasto zerado no espelho — o cron de coleta rodou?');

  /**
   * 🚨 A MÉDIA DE GASTO NÃO É O ORÇAMENTO DE HOJE, e confundir os dois corta a
   * conta pela metade sem ninguém perceber.
   *
   * `diaAtual` é gasto médio dos últimos DIAS dias. Orçamento mudado HOJE não
   * aparece nessa média — em 13/09 Sorocaba foi pra R$ 120 e Campinas pra
   * R$ 100, e o espelho ainda mostrava R$ 40 nas duas. Repartir a média
   * levaria o total das PMax de R$ 370 pra baixo e ninguém veria de onde veio.
   *
   * Por isso o total a repartir é PARÂMETRO. Sem `TOTAL`, o script usa a média
   * e AVISA — nunca aplica silenciosamente uma redução que ninguém pediu.
   */
  const totalDia = Number(process.env.TOTAL || 0) || mediaGasta;
  const usouMedia = !Number(process.env.TOTAL);

  /* Reparte o MESMO total diário na proporção da receita ajustada, com piso. */
  for (const l of linhas) l.proposto = Math.max(PISO_DIARIO, (l.receitaAjustada / somaAjustada) * totalDia);
  /* O piso desequilibra a soma; reescala quem está acima do piso pra fechar. */
  const fixos = linhas.filter((l) => l.proposto === PISO_DIARIO);
  const moveis = linhas.filter((l) => l.proposto !== PISO_DIARIO);
  const sobra = totalDia - fixos.length * PISO_DIARIO;
  const somaMoveis = moveis.reduce((s, l) => s + l.receitaAjustada, 0);
  for (const l of moveis) l.proposto = (l.receitaAjustada / somaMoveis) * sobra;
  /* Múltiplo de R$ 5 — orçamento quebrado não ajuda ninguém a conferir. */
  for (const l of linhas) l.proposto = Math.max(PISO_DIARIO, Math.round(l.proposto / 5) * 5);

  linhas.sort((a, b) => b.receitaAjustada - a.receitaAjustada);

  console.log(`conta ${CONTA} · últimos ${DIAS} dias · SÓ LEITURA\n`);
  console.log('loja                    receita        ajustada    hoje/dia   proposto   delta   R$ gasto p/ R$1.000');
  for (const l of linhas) {
    const delta = l.proposto - l.diaAtual;
    const eficiencia = l.receita ? (l.gasto / l.receita) * 1000 : 0;
    console.log(
      `${l.cidade.padEnd(21)} ${brl(l.receita).padStart(13)} ${brl(l.receitaAjustada).padStart(13)} ` +
        `${brl(l.diaAtual).padStart(10)} ${brl(l.proposto).padStart(10)} ` +
        `${(delta >= 0 ? '+' : '') + delta.toFixed(0)}`.padStart(8) +
        `   ${brl(eficiencia).padStart(10)}${l.fator !== 1 ? '  (metade)' : ''}`,
    );
  }
  console.log(
    `\ntotal repartido: ${brl(totalDia)}/dia` +
      `\nreceita da rede em ${DIAS}d: ${brl(linhas.reduce((s, l) => s + l.receita, 0))}`,
  );
  if (usouMedia) {
    console.log(
      `\n🚨 ATENÇÃO — o total acima é a MÉDIA GASTA em ${DIAS} dias (${brl(mediaGasta)}/dia),` +
        `\n   NÃO o orçamento de hoje. Orçamento mudado recentemente ainda não entrou nessa` +
        `\n   média. Aplicar assim pode ENCOLHER a conta sem ninguém pedir.` +
        `\n   Confira o orçamento real com:` +
        `\n     railway run --service flowops-lite node backend/scripts/diag-google-ads-lojas.js` +
        `\n   e rode de novo passando o total das 14 PMax:  $env:TOTAL="500"`,
    );
  }

  /* Quem está mais fora do lugar — é onde a mudança dói ou salva mais. */
  const fora = linhas
    .map((l) => ({ ...l, delta: l.proposto - l.diaAtual }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);
  console.log('\nMAIORES DESLOCAMENTOS');
  for (const l of fora) {
    console.log(
      `  ${l.delta >= 0 ? '▲' : '▼'} ${l.cidade.padEnd(21)} ${brl(l.diaAtual)} → ${brl(l.proposto)}  ` +
        `(${l.delta >= 0 ? 'recebe' : 'devolve'} ${brl(Math.abs(l.delta))}/dia)`,
    );
  }

  console.log(`\n── COLE ISTO em backend/scripts/google-ads-lojas-orcamento.js ──\n`);
  console.log('const ORCAMENTO_NOVO = {');
  for (const l of linhas.slice().sort((a, b) => a.campanha.localeCompare(b.campanha))) {
    console.log(`  '${l.campanha}': ${l.proposto.toFixed(1)},`);
  }
  console.log('};');
  console.log(
    `\n⚠️ Confira antes de aplicar: mudança grande de orçamento REABRE o aprendizado` +
      `\n   da PMax. Deslocamento acima de ~30% de uma vez costuma custar alguns dias de` +
      `\n   instabilidade — se for o caso, vale mover em duas etapas.`,
  );
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
