import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * O GASTO (E A CONVERSÃO) DO GOOGLE ADS, ESPELHADO NO POSTGRES.
 *
 * Gêmeo do `MetaAdsService`, criado em 22/08/2026 pelo mesmo motivo e com o
 * mesmo desenho: API de terceiro no caminho de render é tela que trava quando
 * o terceiro treme, então o cron traz e o Postgres serve.
 *
 * ── POR QUE O GOOGLE PRECISA DE MAIS COISA QUE O META ──
 *
 * Do Meta basta o gasto: a receita já mora em `Order.utmId`, porque o Meta
 * preenche `utm_id={{campaign.id}}` sozinho no link. O Google, com auto-tagging
 * ligado, entrega só o `gclid` — e `gclid` é identificador de PESSOA, então o
 * site guarda o fato (`pago=true`) e a plataforma, nunca o id. Resultado: sem
 * `utm_id={campaignid}` no sufixo de URL final da conta, `Order.utmId` fica
 * NULL, e em Postgres `NULL = NULL` nunca casa — a nossa receita do Google lê
 * zero mesmo com a conta faturando.
 *
 * Por isso este espelho traz TAMBÉM `conversions` e `conversions_value`: é o
 * número do Google, medido pelo Google. Enquanto o UTM não estiver corrigido é
 * a única resposta que existe; depois de corrigido continua valendo como
 * segunda opinião.
 *
 * ⚠️ **As duas contas não vão bater, e não deviam.** O Google credita a
 * conversão no dia do CLIQUE (retroativo, até 90 dias) e conta view-through; o
 * nosso caixa conta no dia do PEDIDO e só último clique. Divergência aqui é
 * informação, não defeito — o que seria defeito é uma das duas sumir.
 *
 * ── AUTENTICAÇÃO: TRÊS CREDENCIAIS DIFERENTES ──
 *
 *  1. `developer-token` — do CENTRO DE CLIENTES (MCC), aprovado pelo Google.
 *     Não é OAuth, é header à parte, e é o passo que depende do dono.
 *  2. OAuth (`client_id` + `client_secret` + `refresh_token`) — quem é a
 *     pessoa que autoriza a leitura. O refresh token não expira sozinho, mas
 *     morre se a senha da conta Google mudar ou o acesso for revogado.
 *  3. `login-customer-id` — o MCC pelo qual a leitura passa. Só é obrigatório
 *     quando a conta lida está DENTRO de um centro de clientes.
 *
 * ── DESLIGADO SEM CREDENCIAL, E NUNCA MENTINDO ZERO ──
 *
 * Sem as envs o cron não roda e a tela diz "gasto não configurado" em vez de
 * ROAS zerado. Zero é uma afirmação; ausência é outra coisa, e confundir as
 * duas já custou caro nesta mesma tela.
 */
@Injectable()
export class GoogleAdsService {
  private readonly logger = new Logger(GoogleAdsService.name);

  /**
   * A versão da API vive ~1 ano e depois o endpoint some (HTTP 404 seco, sem
   * aviso). Por isso é env: quando o Google aposentar esta, dá pra subir a
   * versão sem deploy de código.
   */
  private get versao(): string {
    return this.config.get<string>('GOOGLE_ADS_API_VERSION')?.trim() || 'v25';
  }

  /** Access token em memória — vale ~1h, não faz sentido pedir por chamada. */
  private acesso: { token: string; expiraEm: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private env(nome: string): string | null {
    return this.config.get<string>(nome)?.trim() || null;
  }

  /** Contas a coletar (`customer_id` sem hífen), separadas por vírgula. */
  private contas(): string[] {
    return (this.config.get<string>('GOOGLE_ADS_CONTAS') || '')
      .split(',')
      .map((c) => c.trim().replace(/\D/g, ''))
      .filter(Boolean);
  }

  configurado(): boolean {
    return Boolean(
      this.env('GOOGLE_ADS_DEVELOPER_TOKEN') &&
        this.env('GOOGLE_ADS_CLIENT_ID') &&
        this.env('GOOGLE_ADS_CLIENT_SECRET') &&
        this.env('GOOGLE_ADS_REFRESH_TOKEN') &&
        this.contas().length > 0,
    );
  }

  /**
   * Cron de hora em hora, no minuto 17. O do Meta é no 7 de propósito: dois
   * espelhos batendo em APIs diferentes no mesmo minuto disputam o mesmo pico
   * de CPU do Railway sem precisar.
   *
   * Recolhe 7 dias por vez. No Meta isso cobre o reprocessamento de
   * atribuição; aqui cobre o ATRASO DE CONVERSÃO, que é maior — a compra de
   * hoje pode ser creditada num clique da semana passada.
   */
  @Cron('17 * * * *')
  async cronColeta(): Promise<void> {
    if (!this.configurado()) return;
    try {
      const n = await this.coletar(7);
      this.logger.log(`gasto do Google atualizado: ${n} linha(s)`);
    } catch (err) {
      // NUNCA lança: relatório sem gasto é ruim, derrubar o processo por causa
      // de métrica é inaceitável.
      this.logger.error(`falha ao coletar gasto do Google: ${String(err)}`);
    }
  }

  /** Puxa `dias` dias (contando hoje) de todas as contas configuradas. */
  async coletar(dias = 7): Promise<number> {
    if (!this.configurado()) return 0;

    const desde = this.diaSP(-Math.max(0, dias - 1));
    const ate = this.diaSP(0);
    let gravadas = 0;

    for (const conta of this.contas()) {
      const linhas = await this.buscarConta(conta, desde, ate);
      for (const l of linhas) {
        await (this.prisma as any).googleAdsGastoDia.upsert({
          where: {
            contaId_campanhaId_dia: { contaId: conta, campanhaId: l.campanhaId, dia: l.dia },
          },
          create: { contaId: conta, ...l },
          update: {
            campanhaNome: l.campanhaNome,
            gasto: l.gasto,
            impressoes: l.impressoes,
            cliques: l.cliques,
            conversoes: l.conversoes,
            valorConversoes: l.valorConversoes,
          },
        });
        gravadas += 1;
      }
    }
    return gravadas;
  }

  /** 'YYYY-MM-DD' de hoje+offset no fuso da loja, não em UTC. */
  private diaSP(offset: number): string {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
    return fmt.format(new Date(Date.now() + offset * 86_400_000));
  }

  /**
   * Troca o refresh token por um access token. Guarda em memória com 60s de
   * folga — token que vence no meio da coleta derruba a segunda conta e deixa
   * a primeira gravada, que é o pior dos mundos pra depurar.
   */
  private async token(): Promise<string> {
    const agora = Date.now();
    if (this.acesso && this.acesso.expiraEm > agora + 60_000) return this.acesso.token;

    const corpo = new URLSearchParams({
      client_id: this.env('GOOGLE_ADS_CLIENT_ID') ?? '',
      client_secret: this.env('GOOGLE_ADS_CLIENT_SECRET') ?? '',
      refresh_token: this.env('GOOGLE_ADS_REFRESH_TOKEN') ?? '',
      grant_type: 'refresh_token',
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: corpo,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      // `invalid_grant` aqui quase sempre é refresh token revogado (senha da
      // conta Google trocada, ou acesso removido) — não é erro de rede.
      throw new Error(
        `OAuth ${res.status}: ${json.error ?? ''} ${json.error_description ?? ''}`.trim(),
      );
    }

    this.acesso = {
      token: json.access_token,
      expiraEm: agora + (Number(json.expires_in) || 3600) * 1000,
    };
    return this.acesso.token;
  }

  /**
   * UMA CHAMADA AUTENTICADA À API — o lugar único que monta os três headers.
   *
   * Público porque o `GoogleAdsConversaoService` (que devolve a venda pro
   * Google) usa a mesma credencial. Duplicar a montagem de header em dois
   * serviços significaria consertar `login-customer-id` em dois lugares no dia
   * em que o MCC mudar, e esquecer um.
   */
  async requisitar(caminho: string, corpo: unknown): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.token()}`,
      'developer-token': this.env('GOOGLE_ADS_DEVELOPER_TOKEN') ?? '',
      'Content-Type': 'application/json',
    };
    // Só vai quando existe: mandar `login-customer-id` de um MCC que não é pai
    // da conta é erro de permissão, não header ignorado.
    const mcc = this.env('GOOGLE_ADS_LOGIN_CUSTOMER_ID')?.replace(/\D/g, '');
    if (mcc) headers['login-customer-id'] = mcc;

    const res = await fetch(`https://googleads.googleapis.com/${this.versao}/${caminho}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const texto = await res.text().catch(() => '');
      throw new Error(`Google ${res.status} em ${caminho}: ${texto.slice(0, 400)}`);
    }
    return res.json();
  }

  /**
   * CHAMADA À **DATA MANAGER API** — outro host, outras regras.
   *
   * Desde 15/06/2026 o Google recusa `ConversionUploadService.UploadClickConversions`
   * de integração nova (`CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`) e manda usar
   * esta API. Medido na conta 892-523-1246 em 23/08/2026.
   *
   * ⚠️ Aqui NÃO vão `developer-token` nem `login-customer-id`: a Data Manager
   * autentica só pelo OAuth e identifica a conta pelo `destinations[]` do corpo.
   * Mandar os headers do Ads não é ignorado — é 400.
   *
   * ⚠️ O escopo é OUTRO: `.../auth/datamanager`. O refresh token precisa ter
   * sido gerado com ele E com `.../auth/adwords`, senão uma das duas pontas cai.
   */
  async requisitarDataManager(caminho: string, corpo: unknown): Promise<any> {
    const res = await fetch(`https://datamanager.googleapis.com/v1/${caminho}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const texto = await res.text().catch(() => '');
      throw new Error(`DataManager ${res.status} em ${caminho}: ${texto.slice(0, 400)}`);
    }
    return res.json();
  }

  /**
   * Uma linha por campanha POR DIA. O `segments.date` no SELECT é o que quebra
   * o período em dias — sem ele o Google devolve o intervalo somado e não dá
   * pra cruzar com o filtro De/Até da tela.
   */
  private async buscarConta(
    conta: string,
    desde: string,
    ate: string,
  ): Promise<
    Array<{
      campanhaId: string;
      campanhaNome: string | null;
      dia: Date;
      gasto: number;
      impressoes: number;
      cliques: number;
      conversoes: number;
      valorConversoes: number;
    }>
  > {
    const query = [
      'SELECT campaign.id, campaign.name, segments.date,',
      '       metrics.cost_micros, metrics.impressions, metrics.clicks,',
      '       metrics.conversions, metrics.conversions_value',
      '  FROM campaign',
      ` WHERE segments.date BETWEEN '${desde}' AND '${ate}'`,
    ].join('\n');

    // `searchStream` devolve um ARRAY de lotes, cada um com `results` — não um
    // objeto com `results` na raiz. Ler `json.results` direto volta vazio sem
    // erro nenhum, que é o jeito mais fácil de achar que a conta não gastou.
    const corpo = (await this.requisitar(
      `customers/${conta}/googleAds:searchStream`,
      { query },
    )) as unknown;
    const lotes: Array<{ results?: any[] }> = Array.isArray(corpo)
      ? (corpo as Array<{ results?: any[] }>)
      : [corpo as { results?: any[] }];
    const linhas = lotes.flatMap((l) => l?.results ?? []);

    return linhas
      .map((r: any) => ({
        campanhaId: String(r.campaign?.id ?? ''),
        campanhaNome: r.campaign?.name ? String(r.campaign.name).slice(0, 200) : null,
        // 'YYYY-MM-DD' → meia-noite UTC, que é o que a coluna `@db.Date`
        // guarda. O recorte de fuso já foi feito pelo Google, no fuso da conta.
        dia: new Date(`${r.segments?.date}T00:00:00.000Z`),
        // MICROS. Um milhão de micros = R$ 1,00. Gravar micros aqui seria
        // repetir o bug do preço 100× do espelho Wincred, só que 1.000.000×.
        gasto: (Number(r.metrics?.costMicros) || 0) / 1_000_000,
        impressoes: Number(r.metrics?.impressions) || 0,
        cliques: Number(r.metrics?.clicks) || 0,
        conversoes: Number(r.metrics?.conversions) || 0,
        valorConversoes: Number(r.metrics?.conversionsValue) || 0,
      }))
      .filter((l) => l.campanhaId && !Number.isNaN(l.dia.getTime()));
  }
}
