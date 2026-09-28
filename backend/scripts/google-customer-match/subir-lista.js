/**
 * SOBE A LISTA DE COMPRADORAS DO SITE pro Customer Match — Data Manager API.
 *
 * Por que a Data Manager e não o caminho clássico: desde 01/04/2026 o Google
 * recusa `OfflineUserDataJobService`/`UserDataService` de Customer Match quando
 * o projeto Google Cloud nunca mandou Customer Match antes — e o nosso nunca
 * mandou. A Data Manager é a MESMA API que o `google-ads.service.ts` já usa
 * pras conversões do site desde 23/08/2026, com a MESMA credencial.
 *
 * DOIS MODOS:
 *   node subir-lista.js            → ENSAIO A SECO. `validateOnly: true` nas
 *                                    duas chamadas. O Google confere e NÃO
 *                                    grava nada: nenhuma lista é criada,
 *                                    nenhum e-mail sobe.
 *   node subir-lista.js --aplicar  → cria a lista e sobe os membros de verdade.
 *
 * ⚠️ O e-mail sobe SEMPRE em SHA-256 hex, nunca em texto puro (o Google recusa
 * texto puro) — e `encoding: 'HEX'` tem que ir no TOPO do corpo, senão é 400
 * seco mesmo com o hash certo.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APLICAR = process.argv.includes('--aplicar');
const CONTA = (process.env.LISTA_CONTA || '8925231246').replace(/\D/g, '');
const NOME_LISTA = process.env.LISTA_NOME || 'Compradoras do site - 12 meses';
const ARQUIVO = process.env.LISTA_ARQUIVO || path.join(__dirname, 'site-12m-email.csv');
const LOTE = 1000;

const env = (n) => (process.env[n] || '').trim();

async function token() {
  const corpo = new URLSearchParams({
    client_id: env('GOOGLE_ADS_CLIENT_ID'),
    client_secret: env('GOOGLE_ADS_CLIENT_SECRET'),
    refresh_token: env('GOOGLE_ADS_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: corpo,
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`OAuth ${res.status}: ${j.error || ''} ${j.error_description || ''}`.trim());
  }
  return j.access_token;
}

/** A Data Manager NÃO leva `developer-token` nem `login-customer-id` no header:
 *  mandar os headers do Ads lá não é ignorado, é 400. A conta vai no corpo. */
async function dm(caminho, corpo, metodo = 'POST') {
  const res = await fetch(`https://datamanager.googleapis.com/v1/${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${await TOKEN}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const texto = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${caminho}\n${texto.slice(0, 900)}`);
  try {
    return JSON.parse(texto);
  } catch {
    return {};
  }
}

let TOKEN;

(async () => {
  console.log(`\n=== CUSTOMER MATCH — ${APLICAR ? 'APLICANDO DE VERDADE' : 'ENSAIO A SECO (nada é gravado)'} ===`);
  console.log(`conta ..... ${CONTA}`);
  console.log(`lista ..... "${NOME_LISTA}"`);

  const cruas = fs
    .readFileSync(ARQUIVO, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const cabecalho = (cruas.shift() || '').toLowerCase();
  const COMPLETO = cabecalho.includes('phone');
  if (!cruas.length) throw new Error('arquivo vazio');
  console.log(`arquivo ... ${path.basename(ARQUIVO)} (${cruas.length} pessoas, ${COMPLETO ? 'e-mail + telefone + endereço' : 'só e-mail'})\n`);

  const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
  /** Já hasheado passa direto; texto puro é hasheado aqui. O Google recusa
   *  texto puro, então nada sai daqui sem passar por SHA-256. */
  const h = (v) => (/^[0-9a-f]{64}$/.test(v) ? v : sha(String(v).trim().toLowerCase()));

  /**
   * Cada pessoa vira uma lista de identificadores. Quanto mais o Google tem,
   * mais gente ele casa — e-mail morto pode casar pelo telefone.
   * ⚠️ `regionCode` e `postalCode` vão em TEXTO PURO; só nome e sobrenome são
   * hasheados dentro de `address`.
   */
  const pessoas = cruas.map((linha) => {
    if (!COMPLETO) return [{ emailAddress: h(linha) }];
    const [email, fone, first, last, pais, cep] = linha.split(',');
    const ids = [];
    if (email) ids.push({ emailAddress: h(email) });
    if (fone) ids.push({ phoneNumber: h(fone) });
    // O bloco de endereço só vale COMPLETO — meio endereço é recusado.
    if (first && last && pais && cep) {
      ids.push({ address: { givenName: h(first), familyName: h(last), regionCode: pais, postalCode: cep } });
    }
    return ids;
  });
  const enviaveis = pessoas.filter((p) => p.length);
  const vazias = pessoas.length - enviaveis.length;
  if (vazias) console.log(`  ⚠ ${vazias} linha(s) sem identificador nenhum — ficam de fora`);

  TOKEN = await token();
  console.log('✓ OAuth ok\n');

  const mcc = env('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replace(/\D/g, '');

  // ── 1. a lista ────────────────────────────────────────────────────────────
  const pai = `accountTypes/GOOGLE_ADS/accounts/${CONTA}`;
  const corpoLista = {
    displayName: NOME_LISTA,
    description:
      env('LISTA_DESC') ||
      'Compradoras do site (WooCommerce + lurds.com.br). Gerada do Postgres do FlowOps.',
    ingestedUserListInfo: { uploadKeyTypes: ['CONTACT_ID'] },
    // Duration em SEGUNDOS, múltiplo exato de 24h — não é "…Days". 540 dias é
    // o teto do Customer Match.
    membershipDuration: `${540 * 86400}s`,
  };

  let listaId = env('LISTA_ID');
  if (!listaId) {
    const r = await dm(`${pai}/userLists${APLICAR ? '' : '?validateOnly=true'}`, corpoLista);
    listaId = String(r?.id || r?.name || '').split('/').pop() || '';
    console.log(APLICAR ? `✓ lista criada — id ${listaId}` : `✓ criação da lista VALIDADA pelo Google (não criada)`);
    // Sem lista criada não há `productDestinationId` pra validar membros contra.
    if (!APLICAR) {
      return console.log(
        '\nEnsaio a seco parou aqui: validar membros exige a lista existindo.\n' +
          'Rode com --aplicar (a lista é criada e os membros passam por uma\n' +
          'validação a seco antes de qualquer e-mail subir de verdade).\n',
      );
    }
  } else {
    console.log(`usando lista existente — id ${listaId}`);
  }

  // ── 2. os membros ─────────────────────────────────────────────────────────
  const destino = {
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: CONTA },
    productDestinationId: String(listaId),
  };
  if (mcc) destino.loginAccount = { accountType: 'GOOGLE_ADS', accountId: mcc };

  /** Monta o corpo do ingest. `seco` = o Google confere e não grava nada. */
  const montar = (pedaco, seco) => ({
      destinations: [destino],
      audienceMembers: pedaco.map((ids) => ({ userData: { userIdentifiers: ids } })),
      encoding: 'HEX',
      // `ACCEPTED` aqui é uma AFIRMAÇÃO de que os Termos de Dados de Clientes
      // foram aceitos NA CONTA — aceite humano, na tela do Google Ads. Só vai
      // quando o dono disser que aceitou (TERMOS_ACEITOS=1). Afirmar isso por
      // conta própria seria assinar no lugar dele.
      ...(env('TERMOS_ACEITOS') === '1'
        ? { termsOfService: { customerMatchTermsOfServiceStatus: 'ACCEPTED' } }
        : {}),
    ...(seco ? { validateOnly: true } : {}),
  });

  // Ensaio a seco do INGEST antes de mandar 5 mil e-mails: se faltar aceite de
  // termos ou a conta não for elegível, o erro aparece aqui, com a lista ainda
  // vazia e nenhum dado de cliente entregue.
  await dm('audienceMembers:ingest', montar(enviaveis.slice(0, 10), true));
  console.log('✓ membros validados pelo Google (nada gravado ainda)');

  if (!APLICAR) {
    return console.log('\nEnsaio a seco completo: a lista e os membros passam. Nada foi criado nem enviado.\n');
  }

  let enviados = 0;
  for (let i = 0; i < enviaveis.length; i += LOTE) {
    const pedaco = enviaveis.slice(i, i + LOTE);
    const r = await dm('audienceMembers:ingest', montar(pedaco, false));
    enviados += pedaco.length;
    const avisos = Array.isArray(r?.fieldWarnings) ? r.fieldWarnings.length : 0;
    console.log(`  lote ${i / LOTE + 1}: ${pedaco.length} membros enviados${avisos ? ` (${avisos} avisos)` : ''}`);
  }

  console.log(`\n✓ ${enviados} e-mails SUBIRAM`);
  console.log(`  lista ${listaId} na conta ${CONTA} — o Google leva algumas horas pra dizer o tamanho casado.\n`);
})().catch((e) => {
  console.error(`\nERRO: ${e.message}\n`);
  process.exit(1);
});
