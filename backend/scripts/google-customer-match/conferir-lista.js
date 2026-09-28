/**
 * Confere uma lista de Customer Match já criada: nome, status e tamanho casado.
 *
 * ⚠️ O tamanho ("size") demora HORAS pra sair do zero — o Google casa os hashes
 * no ritmo dele. Zero logo depois de subir é esperado, não é falha.
 *
 *   railway run --service flowops-lite node backend/scripts/google-customer-match/conferir-lista.js
 *
 * `LISTA_ID` escolhe a lista; sem ela, mostra todas as listas de contato da conta.
 */
const env = (n) => (process.env[n] || '').trim();
const CONTA = (env('LISTA_CONTA') || '8925231246').replace(/\D/g, '');
const V = env('GOOGLE_ADS_API_VERSION') || 'v25';

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
  if (!res.ok || !j.access_token) throw new Error(`OAuth ${res.status}: ${j.error_description || j.error || ''}`);
  return j.access_token;
}

(async () => {
  const t = await token();
  const headers = {
    Authorization: `Bearer ${t}`,
    'developer-token': env('GOOGLE_ADS_DEVELOPER_TOKEN'),
    'Content-Type': 'application/json',
  };
  const mcc = env('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replace(/\D/g, '');
  if (mcc) headers['login-customer-id'] = mcc;

  const id = env('LISTA_ID');
  const query = [
    'SELECT user_list.id, user_list.name, user_list.membership_status,',
    '       user_list.size_for_search, user_list.size_for_display,',
    '       user_list.match_rate_percentage, user_list.membership_life_span',
    '  FROM user_list',
    id ? ` WHERE user_list.id = ${Number(id)}` : " WHERE user_list.type = 'CRM_BASED'",
  ].join('\n');

  const res = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Google ${res.status}: ${texto.slice(0, 600)}`);

  // `searchStream` devolve um ARRAY de lotes, cada um com `results` — ler
  // `json.results` na raiz volta vazio sem erro nenhum.
  const corpo = JSON.parse(texto);
  const lotes = Array.isArray(corpo) ? corpo : [corpo];
  const linhas = lotes.flatMap((l) => l?.results ?? []);

  if (!linhas.length) return console.log('nenhuma lista de contato encontrada nessa conta.');
  console.log(`\nconta ${CONTA} — ${linhas.length} lista(s) de contato:\n`);
  for (const r of linhas) {
    const u = r.userList || {};
    console.log(`  "${u.name}"  (id ${u.id})`);
    console.log(`     status ............. ${u.membershipStatus}`);
    console.log(`     tamanho na Busca ... ${u.sizeForSearch ?? 0}`);
    console.log(`     tamanho na Display . ${u.sizeForDisplay ?? 0}`);
    if (u.matchRatePercentage != null) console.log(`     taxa de match ...... ${u.matchRatePercentage}%`);
    console.log('');
  }
  console.log('Tamanho 0 logo depois de subir é esperado: o Google casa os hashes em algumas horas.\n');
})().catch((e) => {
  console.error(`\nERRO: ${e.message}\n`);
  process.exit(1);
});
