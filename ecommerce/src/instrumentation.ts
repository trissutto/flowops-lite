/**
 * CONFERÊNCIA DE RASTREIO NO BOOT — pra "subiu sem pixel" nunca mais ser mudo.
 *
 * O `register()` do Next roda uma vez quando o servidor sobe. É o único
 * momento em que dá pra avisar sobre configuração faltando ANTES de a primeira
 * cliente entrar.
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * Cada destino de tracking se desliga sozinho quando falta a variável dele
 * (`isEnabled()` em cada arquivo de `lib/tracking/destinations/`). Isso é a
 * decisão certa em runtime — chave faltando não pode derrubar a loja. Mas o
 * efeito colateral é que um deploy sem NENHUMA variável de tracking sobe
 * perfeito: o site funciona, vende, e não registra uma conversão. A campanha
 * roda, o dinheiro sai, e o relatório mostra zero.
 *
 * Na auditoria de lançamento (10/08/2026) as chaves nem estavam no
 * `.env.example` — quem configurasse o ambiente lendo só aquele arquivo subiria
 * a loja cega, sem erro nenhum em lugar nenhum. Este arquivo é a outra metade
 * da correção: o `.env.example` documenta, e isto aqui confere de fato.
 *
 * Não lança exceção: rastreio quebrado não pode impedir a loja de vender. O
 * contrato é "gritar no log", não "derrubar o boot".
 */

export async function register(): Promise<void> {
  // `nodejs` só; no runtime edge não há log de servidor que alguém leia.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Em desenvolvimento o normal é não ter chave nenhuma — avisar ali seria
  // barulho que ensina a ignorar o aviso.
  if (process.env.NODE_ENV !== 'production') return;

  const faltando: string[] = [];

  // Meta: o Pixel (navegador) e a CAPI (servidor) usam o MESMO id em duas
  // variáveis. Ter só uma é pior que não ter nenhuma — significa metade das
  // conversões chegando, e um relatório que parece certo estando errado.
  if (!process.env.NEXT_PUBLIC_META_PIXEL_ID) faltando.push('NEXT_PUBLIC_META_PIXEL_ID (Pixel do navegador)');
  if (!process.env.META_PIXEL_ID) faltando.push('META_PIXEL_ID (mesmo id, usado pela CAPI)');
  if (!process.env.META_CAPI_TOKEN) faltando.push('META_CAPI_TOKEN (conversão sobrevive a bloqueio de cookie)');

  // GA4: sem o segredo da Measurement Protocol o `purchase` NÃO chega — ele é
  // disparado no servidor, depois do pagamento, sem navegador aberto.
  if (!process.env.NEXT_PUBLIC_GA4_ID) faltando.push('NEXT_PUBLIC_GA4_ID');
  if (!process.env.GA4_API_SECRET) faltando.push('GA4_API_SECRET (sem ele o GA4 não recebe compra)');

  if (!process.env.NEXT_PUBLIC_GOOGLE_ADS_ID) faltando.push('NEXT_PUBLIC_GOOGLE_ADS_ID');

  if (faltando.length > 0) {
    console.error(
      '\n[tracking] ⚠️  A LOJA SUBIU SEM RASTREIO COMPLETO — campanha paga vai parecer que não vendeu.\n' +
        faltando.map((v) => `  · falta ${v}`).join('\n') +
        '\n  Configurar em: Vercel → projeto do ecommerce → Settings → Environment Variables.\n' +
        '  A lista completa está no .env.example do ecommerce.\n',
    );
  }

  // Código de teste esquecido é pior que chave faltando: o evento SAI, parece
  // que está tudo certo, e cai no "Testar eventos" em vez de na campanha.
  if (process.env.META_CAPI_TEST_CODE) {
    console.error(
      '[tracking] ⚠️  META_CAPI_TEST_CODE está definido EM PRODUÇÃO. Os eventos vão pro ' +
        '"Testar eventos" do Events Manager e NÃO contam como conversão. Apagar a variável.',
    );
  }
}
