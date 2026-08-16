/**
 * QUEM É ROBÔ — classificação pelo user-agent, no servidor.
 *
 * Motivo (dono, 16/08/2026): o card "Agora no site" mostrou "26 pessoas · 25 em
 * /lojas" numa manhã em que /lojas recebia 1 visita por hora. O número não
 * estava quebrado — a conta é `COUNT(DISTINCT session_id)` e cada acesso de
 * robô ganha uma sessão nova, porque o `session_id` nasce no `sessionStorage`
 * do navegador. Robô com JavaScript vira "pessoa navegando".
 *
 * ── O QUE ESTE ARQUIVO PEGA E O QUE NÃO PEGA ──
 *
 * Pega quem SE IDENTIFICA no user-agent, que é a maioria esmagadora: buscador,
 * robô de IA, ferramenta de SEO, prévia de link, monitor. Não pega scraper que
 * mente o UA se passando por Chrome — esse é caçado pelo comportamento, do lado
 * do FlowOps (sessão sem nenhum evento além de `page_view` não conta como
 * pessoa). As duas defesas são de propósito: uma sabe o NOME, a outra pega
 * quem esconde o nome.
 *
 * Só aparece aqui, aliás, robô que EXECUTA JavaScript — o evento é disparado
 * pelo navegador. Scanner que só baixa o HTML nem chega a existir na métrica.
 *
 * A lista é ordenada do mais específico pro mais genérico: `meta-externalagent`
 * tem que casar antes do `bot` solto, senão todo mundo vira "bot".
 */

/** Nome canônico → o que procurar no user-agent (já em minúsculas). */
const CONHECIDOS: ReadonlyArray<readonly [string, RegExp]> = [
  // ── Buscadores (renderizam JS, então caem na métrica) ──
  ['googlebot', /googlebot|google-inspectiontool|storebot-google/],
  ['google-outros', /google-extended|apis-google|feedfetcher-google|mediapartners-google/],
  ['bingbot', /bingbot|adidxbot|bingpreview/],
  ['applebot', /applebot/],
  ['yandexbot', /yandex(bot|images|mobilebot)/],
  ['duckduckbot', /duckduckbot|duckassistbot/],
  ['baiduspider', /baiduspider/],
  ['seznambot', /seznambot/],

  // ── Robôs de IA (coletam conteúdo pra treinar ou pra responder) ──
  ['gptbot', /gptbot/],
  ['chatgpt', /oai-searchbot|chatgpt-user/],
  ['claudebot', /claudebot|claude-web|anthropic-ai/],
  ['perplexitybot', /perplexity/],
  ['bytespider', /bytespider|bytedance/],
  ['amazonbot', /amazonbot/],
  ['ia-outros', /cohere-ai|diffbot|omgili|timpibot|youbot|img2dataset|ai2bot|meta-externalfetcher/],

  // ── SEO e concorrência (varrem o catálogo inteiro; monitoram preço) ──
  ['ahrefsbot', /ahrefs/],
  ['semrushbot', /semrush/],
  ['mj12bot', /mj12bot|majestic/],
  ['dotbot', /dotbot|opensiteexplorer/],
  ['screamingfrog', /screaming frog/],
  ['seo-outros', /dataforseo|serpstat|sitebulb|barkrowler|blexbot|petalbot|zoominfobot/],

  // ── Prévia de link: alguém colou o endereço no app e ele foi buscar a página ──
  ['facebook-preview', /facebookexternalhit|meta-externalagent|facebookcatalog/],
  ['whatsapp-preview', /whatsapp/],
  ['instagram-preview', /instagram.*(bot|crawler)/],
  ['outras-previas', /twitterbot|linkedinbot|telegrambot|slackbot|discordbot|pinterest|redditbot|skypeuripreview|embedly|quora link preview|vkshare/],

  // ── Monitor de disponibilidade e infraestrutura ──
  ['monitor', /uptimerobot|pingdom|betteruptime|statuscake|site24x7|newrelicpinger|datadog|hetrixtools|freshping/],
  ['vercel', /vercel(bot|-screenshot|-favicon)|vercel-fetch/],

  // ── Navegador dirigido por script: é Chrome de verdade, mas não tem gente ──
  ['headless', /headlesschrome|headless_chrome|puppeteer|playwright|phantomjs|electron\/.*headless|chrome-lighthouse|lighthouse/],

  // ── Biblioteca de HTTP: script de alguém, sem navegador nenhum ──
  ['script', /python-requests|python-urllib|aiohttp|httpx|scrapy|curl\/|wget\/|libwww-perl|go-http-client|okhttp|java\/|apache-httpclient|node-fetch|axios\/|got \(|guzzlehttp|postman/],
];

/**
 * Rede genérica pra quem se declara robô sem estar na lista de cima.
 *
 * Palavra que aparece em navegador de gente fica FORA (foi o caso de "preview"
 * e "monitoring"): marcar cliente como robô a some da métrica em silêncio, que
 * é pior do que deixar um robô passar. O `+http://` no fim é assinatura de
 * robô educado — todos publicam o endereço de quem os opera.
 *
 * Cuidado que já custou caro em outro lugar: o navegador DENTRO do Instagram
 * manda "Instagram 302.0.0" no user-agent e é CLIENTE, não robô. Por isso
 * `instagram` sozinho não casa em lugar nenhum deste arquivo.
 */
const GENERICO = /\b(bot|bots|crawler|crawling|spider|scraper|archiver|indexer)\b|[-_]bot\/|\+https?:\/\//;

export interface Robo {
  /** true quando o acesso NÃO é de uma pessoa num navegador. */
  bot: boolean;
  /** Nome canônico ('googlebot', 'gptbot'…) ou null quando é gente. */
  nome: string | null;
}

const GENTE: Robo = { bot: false, nome: null };

/**
 * Classifica um user-agent. Barato de propósito — roda em toda chamada de
 * `/api/events`, no caminho quente do site.
 *
 * User-agent VAZIO conta como robô: navegador de verdade sempre manda um. Só
 * script mal-educado (e alguns bloqueadores agressivos) chega sem. O prejuízo
 * de errar aqui é uma visita legítima virar "robô" na tela; o prejuízo de
 * errar pro outro lado é a métrica continuar mentindo, que foi o problema.
 */
export function detectarRobo(userAgent: string | null | undefined): Robo {
  const ua = String(userAgent ?? '').trim().toLowerCase();
  if (!ua) return { bot: true, nome: 'sem-user-agent' };

  for (const [nome, padrao] of CONHECIDOS) {
    if (padrao.test(ua)) return { bot: true, nome };
  }
  if (GENERICO.test(ua)) return { bot: true, nome: 'outro-robo' };

  return GENTE;
}
