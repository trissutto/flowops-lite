/**
 * CAMPANHA DEMAND GEN DE RECOMPRA — produtos do feed × compradoras do site.
 *
 * Por que Demand Gen e não remarketing comum: a lista é de quem JÁ comprou.
 * Não é "voltar atrás de quem abandonou o carrinho" — é oferecer de novo pra
 * quem já pagou uma vez, no YouTube/Discover/Gmail, com a peça na foto.
 *
 * ── O QUE ELA MIRA ──
 *
 * Produtos: um recorte do feed por `custom_label`. O feed do site publica
 *   custom_label_0 = subcategoria      custom_label_2 = novidades  (43 peças)
 *   custom_label_1 = coleção pontual   custom_label_3 = conforto   (40 peças)
 * ⚠️ NÃO dá pra filtrar Linha Conforto por `product_type`: lá só aparecem as 3
 * peças cuja categoria PRIMÁRIA é linha-conforto. As outras 37 entram como
 * t-shirts-premium/blusas/vestidos. É o `custom_label_3` que enxerga as 40.
 *
 * Gente: a lista de Customer Match das compradoras.
 *
 * ── NASCE PAUSADA ──
 * Texto de anúncio é a cara da marca e orçamento é dinheiro. O script cria
 * tudo `PAUSED`; ligar é um clique do dono (ou `LIGAR=1`).
 *
 *   node criar-demand-gen.js             → ensaio a seco, nada é criado
 *   node criar-demand-gen.js --aplicar   → cria (pausada)
 *
 * Variáveis: ROTULO (`novidades`|`conforto`|…), INDICE (o custom_label, 0-4),
 * LISTA_ID, ORCAMENTO (reais/dia), NOME, LIGAR.
 */
const env = (n) => (process.env[n] || '').trim();

const CONTA = (env('LISTA_CONTA') || '8925231246').replace(/\D/g, '');
const V = env('GOOGLE_ADS_API_VERSION') || 'v25';
const APLICAR = process.argv.includes('--aplicar');

const MERCHANT = env('MERCHANT_ID') || '496061684';
const ROTULO = env('ROTULO') || 'novidades';
const INDICE = env('INDICE') || '2';
const LISTA_ID = env('LISTA_ID') || '9479548071'; // compradoras dos 12 meses
const ORCAMENTO = Number(env('ORCAMENTO') || '100');
const NOME = env('NOME') || `[Claude] Demand Gen - ${ROTULO} - compradoras`;
const LIGAR = env('LIGAR') === '1';
const URL_FINAL = env('URL_FINAL') || 'https://lurds.com.br';

// Assets de marca que a conta já usa (e já foram aprovados pelo Google).
const LOGO = env('LOGO_ASSET') || '103795016069'; // 600x600
const NOME_NEGOCIO = env('NOME_NEGOCIO') || 'Lurds Plus Size';

const TITULOS = (env('TITULOS') ||
  'Você vai amar as novidades|Chegou peça nova pra você|Plus size do 44 ao 56|Sua próxima favorita chegou|Novidades Lurds Plus Size'
).split('|');
const DESCRICOES = (env('DESCRICOES') ||
  'Peças novas toda semana, do 44 ao 56. Entrega para todo o Brasil.|Volte a vestir o que você ama. Novidades plus size com caimento perfeito.'
).split('|');

async function token() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_ADS_CLIENT_ID'),
      client_secret: env('GOOGLE_ADS_CLIENT_SECRET'),
      refresh_token: env('GOOGLE_ADS_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${j.error_description || j.error}`);
  return j.access_token;
}

let H;
async function api(servico, corpo) {
  const res = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/${servico}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(60_000),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`${servico} → ${res.status}\n${texto.slice(0, 900)}`);
  return JSON.parse(texto);
}

async function consultar(query) {
  const res = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`, {
    method: 'POST', headers: H, body: JSON.stringify({ query }), signal: AbortSignal.timeout(60_000),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`consulta → ${res.status}: ${t.slice(0, 400)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((l) => l?.results ?? []);
}

const rec = (tipo, id) => `customers/${CONTA}/${tipo}/${id}`;

(async () => {
  console.log(`\n=== DEMAND GEN — ${APLICAR ? 'CRIANDO' : 'ENSAIO A SECO (nada é criado)'} ===`);
  console.log(`  nome ......... ${NOME}`);
  console.log(`  produtos ..... custom_label_${INDICE} = "${ROTULO}"`);
  console.log(`  gente ........ lista ${LISTA_ID}`);
  console.log(`  orçamento .... R$ ${ORCAMENTO.toFixed(2)}/dia`);
  console.log(`  status ....... ${LIGAR ? 'ENABLED' : 'PAUSED'}\n`);

  H = {
    Authorization: `Bearer ${await token()}`,
    'developer-token': env('GOOGLE_ADS_DEVELOPER_TOKEN'),
    'Content-Type': 'application/json',
  };
  const mcc = env('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replace(/\D/g, '');
  if (mcc) H['login-customer-id'] = mcc;

  const seco = APLICAR ? {} : { validateOnly: true };
  const carimbo = Date.now();

  // RETOMAR: a criação tem 6 passos e o Google recusa por campo novo de vez em
  // quando (a declaração de anúncio político apareceu assim). Quando isso pega
  // no meio, refazer do zero deixa campanha órfã pra trás — passe CAMPANHA_ID
  // e GRUPO_ID e o script continua de onde parou.
  const RETOMAR = env('GRUPO_ID');
  if (RETOMAR && APLICAR) {
    const grupo = rec('adGroups', RETOMAR);
    const grupoId = RETOMAR;
    console.log(`retomando no grupo ${grupoId} (orçamento, campanha, grupo e filtro já existem)\n`);
    await completar(grupo, grupoId, carimbo);
    return;
  }

  // ── 1. orçamento ──────────────────────────────────────────────────────────
  // `explicitlyShared: false` — orçamento exclusivo. Compartilhar faria esta
  // campanha disputar verba com as que já vendem.
  const rOrc = await api('campaignBudgets:mutate', {
    operations: [{
      create: {
        name: `${NOME} - ${carimbo}`,
        amountMicros: String(Math.round(ORCAMENTO * 1e6)),
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      },
    }],
    ...seco,
  });
  let orcamento = rOrc.results?.[0]?.resourceName;
  console.log(`✓ orçamento ${APLICAR ? 'criado' : 'validado'}`);

  // No ensaio a seco o orçamento acima não existe de verdade (o Google não
  // gravou nada), então apontar pra ele derruba a validação da CAMPANHA — que é
  // justamente o que interessa conferir. Emprestamos um orçamento real só pra
  // validação passar adiante; nada é alterado nele.
  if (!APLICAR) {
    const res = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`, {
      method: 'POST',
      headers: H,
      // `status = ENABLED`: a conta tem orçamentos REMOVIDOS, e emprestar um
      // deles devolve "campaign budget no longer exists" — erro que parece da
      // campanha e é só do empréstimo.
      body: JSON.stringify({
        query: "SELECT campaign_budget.resource_name FROM campaign_budget WHERE campaign_budget.status = 'ENABLED' LIMIT 1",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = JSON.parse(await res.text());
    orcamento = (Array.isArray(j) ? j : [j]).flatMap((l) => l?.results ?? [])[0]?.campaignBudget?.resourceName;
  }

  // ── 2. campanha ───────────────────────────────────────────────────────────
  // MAXIMIZE_CONVERSIONS (volume) e não ..._VALUE: campanha nova não tem
  // histórico pro robô estimar valor, e o público é fechado — não há risco de
  // ela sair comprando clique barato de qualquer um.
  const rCamp = await api('campaigns:mutate', {
    operations: [{
      create: {
        name: NOME,
        status: LIGAR ? 'ENABLED' : 'PAUSED',
        advertisingChannelType: 'DEMAND_GEN',
        campaignBudget: orcamento || `customers/${CONTA}/campaignBudgets/-1`,
        maximizeConversions: {},
        shoppingSetting: { merchantId: MERCHANT },
        // Obrigatório desde a EU Political Ads Regulation — sem ele a criação
        // volta "The required field was not present" apontando pra cá. Loja de
        // roupa plus size não veicula anúncio político; a declaração é essa.
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      },
    }],
    ...seco,
  });
  const campanha = rCamp.results?.[0]?.resourceName;
  console.log(`✓ campanha ${APLICAR ? 'criada' : 'validada'}`);

  if (!APLICAR) {
    return console.log(
      '\nEnsaio a seco parou aqui: grupo, filtro de produto e anúncio precisam\n' +
        'da campanha existindo pra serem validados. Rode com --aplicar (nasce PAUSADA).\n',
    );
  }

  // ── 3. grupo de anúncios ──────────────────────────────────────────────────
  const rGrupo = await api('adGroups:mutate', {
    operations: [{ create: { name: `${ROTULO} - compradoras`, campaign: campanha, status: 'ENABLED' } }],
  });
  const grupo = rGrupo.results[0].resourceName;
  const grupoId = grupo.split('/').pop();
  console.log(`✓ grupo criado`);

  // ── 4. quais produtos ─────────────────────────────────────────────────────
  // Uma árvore: raiz SUBDIVISION que se parte pelo custom_label; o galho do
  // nosso rótulo entra, e o "todo o resto" é EXCLUÍDO. Sem o galho do resto a
  // árvore fica incompleta e o Google recusa a partição inteira.
  const INDEX = `INDEX${INDICE}`;
  const tmp = (n) => `customers/${CONTA}/adGroupCriteria/${grupoId}~${n}`;
  await api('adGroupCriteria:mutate', {
    operations: [
      {
        create: {
          resourceName: tmp(-1),
          adGroup: grupo,
          status: 'ENABLED',
          listingGroup: { type: 'SUBDIVISION' },
        },
      },
      {
        create: {
          adGroup: grupo,
          status: 'ENABLED',
          listingGroup: {
            type: 'UNIT',
            parentAdGroupCriterion: tmp(-1),
            caseValue: { productCustomAttribute: { index: INDEX, value: ROTULO } },
          },
        },
      },
      {
        create: {
          adGroup: grupo,
          status: 'ENABLED',
          negative: true,
          listingGroup: {
            type: 'UNIT',
            parentAdGroupCriterion: tmp(-1),
            caseValue: { productCustomAttribute: { index: INDEX } },
          },
        },
      },
    ],
  });
  console.log(`✓ filtro de produto: só custom_label_${INDICE} = "${ROTULO}"`);

  await completar(grupo, grupoId, carimbo, campanha);
})().catch((e) => {
  console.error(`\nERRO: ${e.message}\n`);
  process.exit(1);
});

/** Os dois últimos passos — separados pra poder RETOMAR quando o Google recusa
 *  no meio e a campanha já existe. */
async function completar(grupo, grupoId, carimbo, campanha) {
  // ── 5. quem vê ────────────────────────────────────────────────────────────
  // ⚠️ Demand Gen NÃO aceita a lista pendurada direto no grupo: devolve
  // "Audience segment attachment is not allowed when use audience grouped bit
  // is set to true". A lista precisa estar dentro de um recurso `Audience`, e é
  // o Audience que vira critério do grupo.
  // Idempotente: numa retomada o público pode já estar anexado, e criar de novo
  // devolve o mesmo erro de "audience grouped bit" — que aí não significa nada
  // sobre o formato, só que já está lá.
  const jaTem = await consultar(
    `SELECT ad_group_criterion.criterion_id FROM ad_group_criterion
      WHERE ad_group.id = ${grupoId} AND ad_group_criterion.type = 'AUDIENCE'
        AND ad_group_criterion.status != 'REMOVED'`,
  );
  if (jaTem.length) {
    console.log(`• público já estava anexado — pulando`);
    return anuncio(grupo, grupoId, campanha);
  }

  const rPublico = await api('audiences:mutate', {
    operations: [{
      create: {
        name: `${NOME} - ${carimbo}`,
        description: `Compradoras do site (lista ${LISTA_ID}).`,
        dimensions: [{
          audienceSegments: { segments: [{ userList: { userList: rec('userLists', LISTA_ID) } }] },
        }],
      },
    }],
  });
  const publico = rPublico.results[0].resourceName;

  await api('adGroupCriteria:mutate', {
    operations: [{ create: { adGroup: grupo, status: 'ENABLED', audience: { audience: publico } } }],
  });
  console.log(`✓ público: lista ${LISTA_ID} (via Audience)`);

  return anuncio(grupo, grupoId, campanha);
}

/** Passo 6, separado pra poder ser chamado quando o público já existia. */
async function anuncio(grupo, grupoId, campanha) {
  const rAnuncio = await api('adGroupAds:mutate', {
    operations: [{
      create: {
        adGroup: grupo,
        status: 'ENABLED',
        ad: {
          finalUrls: [URL_FINAL],
          // ⚠️ `DemandGenProductAd` leva UM título e UMA descrição (não são
          // campos repetidos — mandar lista dá "Proto field is not repeating"),
          // e `businessName` é um AdTextAsset, não string. Pra vários títulos
          // rodando em teste, o formato é `DemandGenMultiAssetAd`.
          demandGenProductAd: {
            headline: { text: TITULOS[0].trim() },
            description: { text: DESCRICOES[0].trim() },
            logoImage: { asset: rec('assets', LOGO) },
            businessName: { text: NOME_NEGOCIO },
          },
        },
      },
    }],
  });
  console.log(`✓ anúncio criado`);
  void rAnuncio;

  const id = campanha ? campanha.split('/').pop() : `(grupo ${grupoId})`;
  console.log(`\n✓ PRONTO — campanha ${id}, ${LIGAR ? 'JÁ ATIVA' : 'PAUSADA (ligar é um clique)'}`);
  console.log(`  https://ads.google.com/aw/campaigns?campaignId=${id}\n`);
}
