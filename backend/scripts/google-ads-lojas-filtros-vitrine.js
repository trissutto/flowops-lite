/**
 * AS DUAS VITRINES NO FILTRO DE LISTAGEM DAS 14 PMax — novidades e conforto,
 * sem competir entre si. Conta LOJAS FÍSICAS (9564998046). ESCREVE.
 *
 * ── O QUE ESTÁ ERRADO HOJE (medido 14/09/2026) ──
 *
 * De 14 PMax ativas, **11 servem ZERO produto** em 30 dias. A causa está na
 * árvore de filtro de listagem:
 *
 *   • 13 grupos incluem `product_type[nivel1] = novidades` — um valor que NÃO
 *     EXISTE no feed. O feed manda `product_type` = a nossa taxonomia de menu
 *     (`blusas`, `vestidos`…), nunca "novidades". Filtro apontando pra valor
 *     inexistente = nenhum produto casa.
 *   • ANÁLIA FRANCO tem UM nó só: `⛔ exclui TODO O RESTO`. Exclui o catálogo
 *     inteiro, por construção.
 *
 * Nada disso dá erro. O grupo fica no ar, gasta em texto e imagem, e a parte de
 * Shopping/vitrine local simplesmente não aparece.
 *
 * ── A REGRA DO DONO (14/09) ──
 *
 * "sempre mostrar as novidades que chegam na loja e a linha CONFORTO" +
 * "estes 2 feeds sendo mostrados SEM GERAR COMPETIÇÃO entre eles".
 *
 * O feed agora carrega os dois rótulos, e eles são MUTUAMENTE EXCLUSIVOS por
 * construção (o backend tira o conforto da contagem de novidades):
 *
 *   custom_label_2 = novidades  → as últimas 25 peças cadastradas, tirando as
 *                                 da Linha Conforto  (35 itens hoje)
 *   custom_label_3 = conforto   → a Linha Conforto    (38 itens hoje)
 *
 * ── O DESENHO, E POR QUE ELE É ANINHADO ──
 *
 * Cada nível de subdivisão divide por UMA dimensão só — não dá pra ter uma
 * folha de `custom_label_2` irmã de uma folha de `custom_label_3` no mesmo
 * nível. Então a árvore desce:
 *
 *   📂 raiz
 *     ├─ custom_label_2 = "novidades"   → INCLUI  (ou exclui, ver abaixo)
 *     └─ 📂 custom_label_2 = (o resto)
 *          ├─ custom_label_3 = "conforto"  → INCLUI
 *          └─ custom_label_3 = (o resto)   → EXCLUI
 *
 * E o "sem competição" é resolvido **por grupo de recursos**, não dentro da
 * árvore: na PMax um produto que está em dois grupos da MESMA campanha faz os
 * dois disputarem o mesmo leilão com criativos diferentes. Então cada grupo
 * fica com um papel, e os papéis não se cruzam:
 *
 *   1º grupo da campanha  → as DUAS VITRINES (novidades + conforto). É o grupo
 *                           principal, o que leva o investimento, e é nele que
 *                           o dono quer as duas vitrines. Os dois rótulos são
 *                           exclusivos por construção, então dentro do grupo
 *                           também não há sobreposição.
 *   2º grupo em diante    → O RESTO (exclui novidades e conforto)
 *   campanha de 1 grupo   → as duas vitrines, e o resto fica fora
 *
 * ⚠️ POR QUE O RESTO VAI PROS SECUNDÁRIOS, em vez de uma vitrine em cada grupo:
 * os grupos secundários desta conta são de REMARKETING e de COMPRADORES ("rmk
 * 30d", "outubro_Compradores…"). Trancar um grupo de remarketing na Linha
 * Conforto mudaria o papel dele — quem já visitou a loja é justamente quem tem
 * motivo pra ver o catálogo amplo. E do jeito escolhido o catálogo INTEIRO
 * continua no ar em 11 das 14 cidades, em vez de sobrarem só os 73 itens das
 * duas vitrines.
 *
 * ⚠️ CONSEQUÊNCIA ASSUMIDA: nas três campanhas que têm UM grupo só — ANÁLIA
 * FRANCO, PIRACICABA e SOROCABA — os outros ~872 itens saem do Shopping local.
 * Pra devolvê-los ao ar ali, o caminho é um 2º grupo de recursos; Itanhaém,
 * SJC, Suzano e Vinhedo já têm grupo PAUSADO que serviria (e pausado não é
 * tocado por este script).
 *
 * ── ORDEM OBRIGATÓRIA, E AS DUAS ONDAS ──
 *
 * 🚨 O filtro só casa depois que o MERCHANT leu o feed com os rótulos novos.
 * Apontar pra `custom_label_2` antes disso põe a campanha em zero — é
 * exatamente assim que ela chegou no estado atual.
 *
 * Por isso o script trabalha em duas ondas, e ele MESMO mede quem é quem
 * (`shopping_performance_view`, 30 dias), sem lista chumbada:
 *
 *   ONDA=1  campanhas que hoje servem ZERO produto. Risco nenhum: já estão em
 *           zero, a troca só pode melhorar. Pode rodar antes do Merchant.
 *   ONDA=2  campanhas que HOJE SERVEM produto. Só depois de confirmar que o
 *           Merchant já leu o feed novo, senão derruba o que funciona.
 *
 * ── COMO RODAR ──
 *
 *   # ver o plano, sem tocar em nada (default)
 *   railway run --service flowops-lite node backend/scripts/google-ads-lojas-filtros-vitrine.js
 *
 *   # aplicar a onda 1
 *   $env:APLICAR="1"; $env:ONDA="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-filtros-vitrine.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';
const APLICAR = process.env.APLICAR === '1';
const ONDA = String(process.env.ONDA || '1');

/** Os dois rótulos, do jeito que o feed os escreve. */
const NOVIDADES = { index: 'INDEX2', valor: 'novidades' };
const CONFORTO = { index: 'INDEX3', valor: 'conforto' };

/** O papel de cada grupo dentro da campanha. */
const PAPEL = { NOVIDADES: 'novidades', CONFORTO: 'conforto', RESTO: 'o resto', AMBAS: 'as duas' };

/**
 * QUEM É O GRUPO PRINCIPAL — por nome, nunca pela ordem da API.
 *
 * A ordem em que o Google devolve os grupos não é estável, e "o primeiro da
 * lista" mudaria de dono entre duas execuções: numa rodada o grupo de
 * remarketing ganharia as vitrines e na outra não, sem nada avisar.
 *
 * A régua é o nome, e o caso que a decide é JUNDIAÍ: lá os grupos são
 * "Remarketing" e "outubro_20-10" — não existe "Recursos Jundiaí", então o
 * principal tem que ser o `outubro`, e o de remarketing fica com o resto.
 *
 *   0 = nasceu como grupo principal ("Recursos Santos", "Grupo de recursos 1")
 *   1 = grupo comum de campanha ("outubro_20-10", "Vinhedo")
 *   2 = remarketing ou compradores — só vira principal se não houver outro
 */
function pesoDeNome(nome) {
  const n = String(nome || '').toLowerCase();
  /**
   * ⚠️ `\b` NÃO serve aqui: pra regex o `_` é caractere de palavra, então
   * `\brmk` não casa em "outubro_rmk30d_21_10" — e foi exatamente o nome que
   * o VINHEDO usa. Com `\b`, o grupo de remarketing de Vinhedo era eleito
   * principal e ficava com as duas vitrines. O separador de verdade é
   * "qualquer coisa que não seja letra".
   */
  if (/(^|[^a-z])(rmk|remarketing|comprador)/.test(n)) return 2;
  if (/^(recursos|grupo de recursos)/.test(n)) return 0;
  return 1;
}

async function token() {
  const b = new URLSearchParams({
    client_id: (process.env.GOOGLE_ADS_CLIENT_ID || '').trim(),
    client_secret: (process.env.GOOGLE_ADS_CLIENT_SECRET || '').trim(),
    refresh_token: (process.env.GOOGLE_ADS_REFRESH_TOKEN || '').trim(),
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: b,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth falhou: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

function headers(a) {
  const h = {
    Authorization: `Bearer ${a}`,
    'developer-token': (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim(),
    'Content-Type': 'application/json',
  };
  const mcc = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').trim().replace(/\D/g, '');
  if (mcc) h['login-customer-id'] = mcc;
  return h;
}

async function consultar(a, gaql) {
  const r = await fetch(
    `https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`,
    { method: 'POST', headers: headers(a), body: JSON.stringify({ query: gaql }) },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${t.slice(0, 500)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

/**
 * `searchStream` devolve ARRAY de lotes e o mutate devolve OBJETO — quem lê o
 * erro tem que aguentar os dois, senão a mensagem vira "undefined" na hora
 * exata em que ela importa.
 */
function erroLegivel(bruto) {
  try {
    const j = typeof bruto === 'string' ? JSON.parse(bruto) : bruto;
    const o = Array.isArray(j) ? j[0] : j;
    const f = o?.error?.details?.[0]?.errors?.[0];
    if (!f) return o?.error?.message || String(bruto).slice(0, 300);
    const cod = Object.values(f.errorCode || {})[0] || '?';
    return `${cod} — ${f.message}`;
  } catch {
    return String(bruto).slice(0, 300);
  }
}

/**
 * ⚠️ ESTE endpoint NÃO aceita `partialFailure` — responde
 * `Unknown name "partialFailure": Cannot find field` e não escreve nada. Os
 * outros mutate da conta aceitam, e foi por isso que ele entrou aqui por
 * hábito. Sem o campo o mutate já é atômico por natureza: a árvore do grupo
 * troca inteira ou não troca.
 *
 * `validateOnly` existe e é ouro aqui: deixa o Google conferir a árvore
 * (estrutura, sobreposição, valor de rótulo) SEM gravar. É o que o modo
 * validação usa — bem melhor que eu imprimir o que eu ACHO que ele aceitaria.
 */
async function mutar(a, operacoes, { validar = false } = {}) {
  const r = await fetch(
    `https://googleads.googleapis.com/${V}/customers/${CONTA}/assetGroupListingGroupFilters:mutate`,
    {
      method: 'POST',
      headers: headers(a),
      body: JSON.stringify({ operations: operacoes, ...(validar ? { validateOnly: true } : {}) }),
    },
  );
  const t = await r.text();
  if (!r.ok) return { erro: erroLegivel(t), status: r.status };
  return { ok: (JSON.parse(t).results || []).length };
}

/**
 * A ÁRVORE, montada com ids temporários NEGATIVOS.
 *
 * O resource name de um filtro é `.../assetGroupListingGroupFilters/<id do
 * grupo>~<id do filtro>` — o id temporário respeita esse formato com número
 * negativo, e é assim que o filho aponta pro pai dentro do MESMO mutate.
 */
function montarArvore(grupoRes, papel) {
  const idGrupo = grupoRes.split('/').pop();
  const nome = (n) => `customers/${CONTA}/assetGroupListingGroupFilters/${idGrupo}~-${n}`;
  const base = { assetGroup: grupoRes, listingSource: 'SHOPPING' };
  const rotulo = (d, valor) => ({
    productCustomAttribute: { index: d.index, ...(valor ? { value: valor } : {}) },
  });

  /* Quem entra e quem sai, por papel. A forma da árvore é a mesma nos três. */
  const [tNov, tCnf, tResto] =
    papel === PAPEL.NOVIDADES
      ? ['UNIT_INCLUDED', 'UNIT_EXCLUDED', 'UNIT_EXCLUDED']
      : papel === PAPEL.CONFORTO
        ? ['UNIT_EXCLUDED', 'UNIT_INCLUDED', 'UNIT_EXCLUDED']
        : papel === PAPEL.AMBAS
          ? ['UNIT_INCLUDED', 'UNIT_INCLUDED', 'UNIT_EXCLUDED']
          : ['UNIT_EXCLUDED', 'UNIT_EXCLUDED', 'UNIT_INCLUDED']; // O RESTO

  return [
    /* raiz */
    { create: { ...base, resourceName: nome(1), type: 'SUBDIVISION' } },
    /* custom_label_2 = novidades */
    {
      create: {
        ...base,
        resourceName: nome(2),
        parentListingGroupFilter: nome(1),
        type: tNov,
        caseValue: rotulo(NOVIDADES, NOVIDADES.valor),
      },
    },
    /* custom_label_2 = (o resto) — subdivide pra alcançar o conforto */
    {
      create: {
        ...base,
        resourceName: nome(3),
        parentListingGroupFilter: nome(1),
        type: 'SUBDIVISION',
        caseValue: rotulo(NOVIDADES, null),
      },
    },
    /* custom_label_3 = conforto */
    {
      create: {
        ...base,
        resourceName: nome(4),
        parentListingGroupFilter: nome(3),
        type: tCnf,
        caseValue: rotulo(CONFORTO, CONFORTO.valor),
      },
    },
    /* custom_label_3 = (o resto) */
    {
      create: {
        ...base,
        resourceName: nome(5),
        parentListingGroupFilter: nome(3),
        type: tResto,
        caseValue: rotulo(CONFORTO, null),
      },
    },
  ];
}

/**
 * As remoções do grupo, FOLHA ANTES DA RAIZ.
 *
 * A árvore é uma árvore: apagar o pai antes do filho deixa nó órfão e a API
 * recusa. A profundidade é contada subindo por `pai` até não achar mais.
 */
function remocoesEmOrdem(antigos) {
  const porRes = new Map(antigos.map((x) => [x.res, x]));
  const prof = (n) => {
    let d = 0;
    let cur = n;
    while (cur?.pai && porRes.has(cur.pai)) {
      cur = porRes.get(cur.pai);
      if (++d > 20) break;
    }
    return d;
  };
  return [...antigos].sort((x, y) => prof(y) - prof(x)).map((n) => ({ remove: n.res }));
}

async function main() {
  console.log(`conta ${CONTA} · API ${V} · onda ${ONDA} · ${APLICAR ? '🔴 APLICANDO' : 'VALIDANDO (nada é alterado)'}\n`);
  const a = await token();

  /* 1) Grupos ENABLED das PMax ativas, na ordem em que o Google os devolve. */
  const grupos = await consultar(
    a,
    `SELECT campaign.name, campaign.status, asset_group.resource_name, asset_group.name,
            asset_group.status
       FROM asset_group
      WHERE campaign.status = 'ENABLED'
        AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
        AND asset_group.status = 'ENABLED'`,
  );

  /* 2) Quem serve produto HOJE — é isso que separa a onda 1 da onda 2. */
  const servindo = new Set();
  for (const x of await consultar(
    a,
    `SELECT campaign.name, campaign.status, metrics.impressions
       FROM shopping_performance_view
      WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
  )) {
    if (Number(x.metrics?.impressions || 0) > 0) servindo.add(x.campaign.name);
  }

  /* 3) Os nós que existem, pra saber o que remover (folha antes de raiz). */
  const nosDoGrupo = new Map();
  for (const n of await consultar(
    a,
    `SELECT asset_group.resource_name,
            asset_group_listing_group_filter.resource_name,
            asset_group_listing_group_filter.parent_listing_group_filter
       FROM asset_group_listing_group_filter
      WHERE campaign.status = 'ENABLED'`,
  )) {
    const k = n.assetGroup.resourceName;
    if (!nosDoGrupo.has(k)) nosDoGrupo.set(k, []);
    nosDoGrupo.get(k).push({
      res: n.assetGroupListingGroupFilter.resourceName,
      pai: n.assetGroupListingGroupFilter.parentListingGroupFilter || null,
    });
  }

  /* 4) O papel de cada grupo, por campanha. */
  const porCampanha = new Map();
  for (const g of grupos) {
    if (!porCampanha.has(g.campaign.name)) porCampanha.set(g.campaign.name, []);
    porCampanha.get(g.campaign.name).push({ res: g.assetGroup.resourceName, nome: g.assetGroup.name });
  }

  const plano = [];
  for (const [campanha, lista] of [...porCampanha].sort((x, y) => x[0].localeCompare(y[0]))) {
    const serve = servindo.has(campanha);
    const onda = serve ? '2' : '1';
    /* Principal eleito por nome, com desempate alfabético pra ser repetível. */
    lista.sort((x, y) => pesoDeNome(x.nome) - pesoDeNome(y.nome) || x.nome.localeCompare(y.nome));
    lista.forEach((g, i) => {
      /* Principal leva as duas vitrines; secundário (remarketing) leva o resto. */
      const papel = i === 0 ? PAPEL.AMBAS : PAPEL.RESTO;
      plano.push({ campanha, serve, onda, papel, ...g });
    });
  }

  /* ── O PLANO NA TELA, antes de qualquer escrita ──────────────────────── */
  let campanhaAnterior = '';
  for (const p of plano) {
    if (p.campanha !== campanhaAnterior) {
      campanhaAnterior = p.campanha;
      console.log(
        `\n━━ ${p.campanha}  ${p.serve ? '⚠️ SERVE produto hoje (onda 2)' : '· zero produto hoje (onda 1)'}`,
      );
    }
    const alvo = p.onda === ONDA ? '' : '   (fora desta onda)';
    console.log(
      `   └─ "${p.nome}" → ${p.papel.toUpperCase().padEnd(10)} · ${(nosDoGrupo.get(p.res) || []).length} nó(s) a remover${alvo}`,
    );
  }

  const aFazer = plano.filter((p) => p.onda === ONDA);
  console.log(
    `\n── onda ${ONDA}: ${aFazer.length} grupo(s) em ${new Set(aFazer.map((p) => p.campanha)).size} campanha(s) ──`,
  );

  /**
   * MODO VALIDAÇÃO: manda a árvore pro Google com `validateOnly` e imprime o
   * que ELE responde. Sem isto o dry-run só mostra a minha intenção — e a
   * intenção não é quem decide se a árvore é aceita.
   */
  if (!APLICAR) {
    let bons = 0;
    for (const p of aFazer) {
      const ops = [...remocoesEmOrdem(nosDoGrupo.get(p.res) || []), ...montarArvore(p.res, p.papel)];
      const r = await mutar(a, ops, { validar: true });
      if (r.erro) console.log(`   ⚠️ ${p.campanha} · "${p.nome}" → ${r.erro}`);
      else bons++;
    }
    console.log(`\n${bons}/${aFazer.length} árvore(s) o Google aceita. VALIDAÇÃO — nada foi alterado.`);
    console.log('Para aplicar: APLICAR=1');
    return;
  }

  /* ── APLICA, um grupo por vez ────────────────────────────────────────────
   *
   * Um mutate por GRUPO, `partialFailure: false`: ou a árvore daquele grupo
   * troca inteira, ou ela fica como estava. Meia árvore é o pior estado —
   * grupo sem nó nenhum não anuncia produto e nada avisa.
   */
  let ok = 0;
  const falhas = [];
  for (const p of aFazer) {
    const remocoes = remocoesEmOrdem(nosDoGrupo.get(p.res) || []);
    const ops = [...remocoes, ...montarArvore(p.res, p.papel)];
    let r = await mutar(a, ops);

    /* Se o Google recusar trocar no mesmo request, faz em dois passos. */
    if (r.erro && remocoes.length) {
      const r1 = await mutar(a, remocoes);
      if (r1.erro) r = r1;
      else r = await mutar(a, montarArvore(p.res, p.papel));
    }

    if (r.erro) {
      console.log(`   ❌ ${p.campanha} · "${p.nome}" → ${r.erro}`);
      falhas.push(p);
      /* Quota estourada: parar na hora, não queimar o resto do dia. */
      if (r.status === 429 || /RESOURCE_EXHAUSTED/i.test(r.erro)) {
        console.log('\n🛑 quota da API estourada — parando aqui.');
        break;
      }
    } else {
      console.log(`   ✅ ${p.campanha} · "${p.nome}" → ${p.papel} (${r.ok} nós)`);
      ok++;
    }
  }

  console.log(`\n── RESULTADO ── ${ok} grupo(s) reescrito(s), ${falhas.length} falha(s)`);
  if (ok) {
    console.log('\nO filtro só passa a casar produto depois que o Merchant Center');
    console.log('tiver lido o feed com `custom_label_2`/`custom_label_3`.');
  }
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
