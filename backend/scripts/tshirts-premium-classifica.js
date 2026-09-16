/**
 * T-SHIRTS PREMIUM — devolve a linha de estampa pra categoria dela (16/09/2026).
 *
 * POR QUE ISTO EXISTIU. Em 21/08 nove t-shirts foram classificadas em
 * `t-shirts-premium` pela tela. O IMPORTADOR DE CONTEÚDO do WooCommerce rodava
 * toda madrugada às 04:35 e reescrevia `site_produto.categoria` a partir das
 * categorias do site velho — na última rodada dele (27/08 04:35, horas antes de
 * a KingHost apagar o WordPress) levou 346 peças, e seis t-shirts voltaram pra
 * `blusas` sem que ninguém visse. A categoria ficou com 3 peças no ar.
 * O importador foi aposentado no enterro do Wincred (`site-sync.service.ts`),
 * então o que este script grava FICA.
 *
 * O QUE ELE FAZ. A mesma gravação do `ClassificacaoService.salvarCategoriasDaPeca`
 * — principal `t-shirts-premium`, as categorias que a peça já tinha viram
 * EXTRAS (ela continua em Blusas e Linha Conforto), e as subcategorias viram
 * `subcategorias_extras` porque `t-shirts-premium` não tem filha. A família
 * inteira é resolvida como no catálogo (`grupo_ref` → REF-BASE), senão a irmã
 * que monta o card ficaria pra trás.
 *
 * ⚠️ Não dá pra marcar tudo de uma vez pela tela: `salvarCategoriasDaPeca`
 * mantém como principal "a que já era, se seguir marcada" — marcar
 * [blusas, t-shirts-premium] junto deixaria `blusas` na frente. Por isso a
 * gravação aqui é direta, com o resultado dos DOIS passos.
 *
 * Uso (o `--aplicar` é obrigatório pra gravar; sem ele só mostra):
 *   railway run --service Postgres node backend/scripts/tshirts-premium-classifica.js
 *   railway run --service Postgres node backend/scripts/tshirts-premium-classifica.js --aplicar
 *
 * Depois de aplicar, o backend remonta o catálogo sozinho (a impressão digital
 * do `site_produto` muda), e a vitrine precisa da tag `categoria:*` —
 * `tshirts-premium-revalida.js`, que roda no serviço do app.
 */
const { Client } = require('pg');

const ALVO = 't-shirts-premium';
const QUEM = 'script tshirts-premium-classifica (pedido do dono 16/09)';

/** A linha de estampa/licenciada (decisão do dono, 16/09). */
const REFS = [
  'RAMONES', 'ROLLING', 'DISNEY-012', 'DISNEY-014', 'SNOOPY-001', 'BEATLES',
  'STITCH-004', 'STITCH-005', 'SMILE', 'MARGARIDA', 'AMORE', 'CHIC', 'CAPIVARA',
  'PUGGY-CA', 'PUGGYOFF',
];

/** Mesma régua de `common/ref-base.ts` — sufixo de cor sai, dígito fica. */
const refBase = (ref) => String(ref || '').trim().toUpperCase().replace(/[^0-9]+$/, '') || String(ref || '').trim().toUpperCase();

/** Mesma família do catálogo e da tela de classificação. */
async function familia(db, refBusca) {
  const exata = String(refBusca).trim().toUpperCase();
  const base = refBase(exata);
  const { rows } = await db.query(
    `SELECT ref, grupo_ref, grupo_ref_manual FROM site_produto
      WHERE ref = $1 OR ref LIKE $2 || '%' OR grupo_ref = $2`,
    [exata, base],
  );
  const chave = (l) => {
    const ref = String(l.ref).toUpperCase();
    if (l.grupo_ref_manual && !l.grupo_ref) return ref;
    return String(l.grupo_ref || '').trim().toUpperCase() || refBase(ref);
  };
  const daExata = rows.find((l) => String(l.ref).toUpperCase() === exata);
  const alvo = daExata ? chave(daExata) : base;
  return [...new Set(rows.filter((l) => chave(l) === alvo).map((l) => String(l.ref)))];
}

(async () => {
  const aplicar = process.argv.includes('--aplicar');
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  console.log(aplicar ? '== APLICANDO' : '== SÓ MOSTRANDO (use --aplicar pra gravar)');

  const tags = new Set(['categorias', 'filtros', 'catalogo', `categoria:${ALVO}`]);
  let mexidas = 0;

  for (const refPedida of REFS) {
    const refs = await familia(db, refPedida);
    if (!refs.length) { console.log(`${refPedida.padEnd(12)} SEM CADASTRO no site — pulei`); continue; }

    const { rows } = await db.query(
      `SELECT ref, categoria, subcategoria, categorias_extras, subcategorias_extras, publicado
         FROM site_produto WHERE ref = ANY($1)`, [refs],
    );
    const norm = (v) => String(v || '').trim().toLowerCase();
    const catsAntes = [...new Set(rows.flatMap((r) => [r.categoria, ...(r.categorias_extras || [])]).map(norm).filter(Boolean))];
    const subsAntes = [...new Set(rows.flatMap((r) => [r.subcategoria, ...(r.subcategorias_extras || [])]).map(norm).filter(Boolean))];
    for (const c of catsAntes) tags.add(`categoria:${c}`);

    if (catsAntes.length === 1 && catsAntes[0] === ALVO) {
      console.log(`${refPedida.padEnd(12)} já está só em ${ALVO} — pulei`);
      continue;
    }
    const extras = catsAntes.filter((c) => c !== ALVO);

    console.log(
      `${refPedida.padEnd(12)} ${refs.length} REF | ${catsAntes.join(',') || '-'}` +
      ` → principal=${ALVO} extras=${extras.join(',') || '-'} subsExtras=${subsAntes.join(',') || '-'}`,
    );
    if (!aplicar) continue;

    const r = await db.query(
      `UPDATE site_produto
          SET categoria = $2, subcategoria = NULL,
              categorias_extras = $3, subcategorias_extras = $4,
              classificado_por = $5, classificado_em = NOW(), updated_at = NOW()
        WHERE ref = ANY($1)`,
      [refs, ALVO, extras, subsAntes, QUEM],
    );
    mexidas += r.rowCount;
  }

  console.log(`\n${aplicar ? mexidas + ' REF(s) gravada(s)' : 'nada gravado'}`);
  console.log('tags pra revalidar:', [...tags].join(' '));
  await db.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
