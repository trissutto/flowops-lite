import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import {
  CliqueEntrada,
  EventoEntrada,
  Segmento,
  SiteMetricsService,
  Trafego,
  TRAFEGOS,
} from './site-metrics.service';
import { MetaAdsService } from './meta-ads.service';
import { GoogleAdsService } from './google-ads.service';
import { GoogleAdsConversaoService } from './google-ads-conversao.service';

/**
 * A PORTA DO SITE — server-to-server, do BFF do e-commerce pra cá.
 *
 * Mesmo padrão de `public/loja/config`: token compartilhado em `x-loja-token`,
 * comparado em tempo constante, e 404 (nunca 401) quando não confere — não se
 * confirma pra ninguém que a rota existe.
 *
 * Quem chama é o `/api/events` do Next, não o navegador: o evento já passou
 * pelo gate de consentimento do lado de lá antes de chegar aqui.
 */
@Controller('public/site-metrics')
export class SiteMetricsPublicController {
  constructor(private readonly service: SiteMetricsService) {}

  @Post('cliques')
  @HttpCode(204)
  async registrar(
    @Headers('x-loja-token') token: string,
    @Body() body: { cliques?: CliqueEntrada[] },
  ): Promise<void> {
    this.exigirToken(token);
    const cliques = Array.isArray(body?.cliques) ? body.cliques.slice(0, 50) : [];
    if (!cliques.length) return;
    // 204 mesmo se gravar zero: métrica não devolve erro pro site.
    await this.service.registrar(cliques);
  }

  /**
   * TODO evento do site — a cópia de primeira parte (dono, 13/08). Chega
   * inclusive de visitante SEM aceite do banner, já anonimizado na origem;
   * o consentimento aqui governa só o repasse a terceiros, que é do BFF.
   */
  @Post('eventos')
  @HttpCode(204)
  async registrarEventos(
    @Headers('x-loja-token') token: string,
    @Body() body: { eventos?: EventoEntrada[] },
  ): Promise<void> {
    this.exigirToken(token);
    const eventos = Array.isArray(body?.eventos) ? body.eventos.slice(0, 50) : [];
    if (!eventos.length) return;
    await this.service.registrarEventos(eventos);
  }

  /**
   * O LEAD DO WHATSAPP — quem mandou a mensagem carimbada ("vim pelo site").
   * Quem chama é o n8n (Evolution → webhook), com o MESMO x-loja-token.
   */
  @Post('whatsapp-lead')
  async registrarLeadWhatsapp(
    @Headers('x-loja-token') token: string,
    @Body() body: {
      telefone?: string; nome?: string; loja?: string;
      mensagem?: string; instancia?: string;
    },
  ) {
    this.exigirToken(token);
    return this.service.registrarLeadWhatsapp(body ?? {});
  }

  private segredoConfere(recebido: string, esperado: string): boolean {
    const a = crypto.createHash('sha256').update(recebido).digest();
    const b = crypto.createHash('sha256').update(esperado).digest();
    return crypto.timingSafeEqual(a, b);
  }

  private exigirToken(token?: string): void {
    const esperado = process.env.LOJA_ORDER_TOKEN;
    if (!esperado) throw new NotFoundException();
    if (!token || !this.segredoConfere(token, esperado)) throw new NotFoundException();
  }
}

/**
 * O RELATÓRIO — tela da retaguarda, atrás do JWT.
 *
 * Recorte por De/Até como toda tela com período no sistema. Sem parâmetro,
 * devolve os últimos 30 dias.
 */
@Controller('site-metrics')
@UseGuards(JwtAuthGuard)
export class SiteMetricsController {
  constructor(
    private readonly service: SiteMetricsService,
    private readonly metaAds: MetaAdsService,
    private readonly googleAds: GoogleAdsService,
    private readonly googleAdsConversao: GoogleAdsConversaoService,
  ) {}

  /**
   * COLETA MANUAL DO GASTO DO GOOGLE — o botão de "será que a credencial
   * presta?".
   *
   * O cron roda de hora em hora e engole o erro de propósito (métrica não pode
   * derrubar o processo), o que é certo em produção e péssimo no dia em que
   * alguém acabou de colar as envs: a única prova ficaria no log do Railway,
   * uma hora depois. Aqui o erro do Google VOLTA na resposta — token de
   * desenvolvedor não aprovado, refresh token revogado e conta fora do MCC
   * dizem coisas diferentes, e cada uma tem um conserto diferente.
   */
  @Post('google-ads/sync')
  async sincronizarGoogleAds(@Req() req: any, @Query('dias') dias?: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    if (!this.googleAds.configurado()) {
      return { ok: false, configurado: false, erro: 'Faltam as envs do Google Ads' };
    }
    const janela = Math.min(Math.max(Number(dias) || 7, 1), 90);
    try {
      const linhas = await this.googleAds.coletar(janela);
      return { ok: true, configurado: true, dias: janela, linhas };
    } catch (err) {
      return { ok: false, configurado: true, erro: String(err).slice(0, 500) };
    }
  }

  /**
   * ENVIO MANUAL DAS CONVERSÕES PENDENTES — o mesmo motivo do sync acima.
   *
   * Quem acabou de configurar precisa ver o Google aceitar (ou recusar, e por
   * quê) agora, não daqui a 10 minutos num log. A recusa mais comum é clique
   * fora da janela da ação de conversão, e ela vem escrita na resposta.
   */
  @Post('google-ads/conversoes')
  async enviarConversoesGoogleAds(@Req() req: any, @Query('limite') limite?: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    if (!this.googleAdsConversao.configurado()) {
      return {
        ok: false,
        configurado: false,
        erro: 'Faltam as envs do Google Ads ou GOOGLE_ADS_CONVERSAO_ACTION_ID',
      };
    }
    try {
      const enviadas = await this.googleAdsConversao.enviarPendentes(
        Math.min(Math.max(Number(limite) || 200, 1), 2000),
      );
      return { ok: true, configurado: true, enviadas };
    } catch (err) {
      return { ok: false, configurado: true, erro: String(err).slice(0, 500) };
    }
  }

  /**
   * QUEM ESTÁ NO SITE AGORA — o card ao vivo da tela de cliques.
   * Sem parâmetro de propósito: "agora" não tem De/Até.
   */
  @Get('agora')
  async agora(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.service.agora();
  }

  @Get('lojas')
  async lojas(@Req() req: any, @Query('de') de?: string, @Query('ate') ate?: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');

    const fim = this.fimDoDia(ate) ?? this.fimDoDia(this.hoje())!;
    const inicio = this.inicioDoDia(de) ?? new Date(fim.getTime() - 29 * 24 * 60 * 60 * 1000);

    const { linhas, totalCliques } = await this.service.porLoja(inicio, fim);
    return {
      de: inicio.toISOString(),
      ate: fim.toISOString(),
      totalCliques,
      linhas,
    };
  }

  /** Leads do WhatsApp (mensagem carimbada) — tela /retaguarda/leads-whatsapp. */
  @Get('whatsapp-leads')
  async whatsappLeads(@Req() req: any, @Query('de') de?: string, @Query('ate') ate?: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');

    const fim = this.fimDoDia(ate) ?? this.fimDoDia(this.hoje())!;
    const inicio = this.inicioDoDia(de) ?? new Date(fim.getTime() - 29 * 24 * 60 * 60 * 1000);

    const dados = await this.service.leadsWhatsapp(inicio, fim);
    return { de: inicio.toISOString(), ate: fim.toISOString(), ...dados };
  }

  /**
   * O funil do site (visita → sacola → checkout → compra) — mesma janela De/Até.
   *
   * A CASCATA vem na query string: `trafego` (pago/organico/direto),
   * `plataforma` e `campanha`. Vazio em qualquer nível = "tudo" daquele nível.
   *
   * O recorte vale pro relatório INTEIRO — funil, jornada, problemas,
   * interações e tráfego de lojas saem todos do mesmo segmento. Tela em que
   * metade dos quadros responde uma pergunta e a outra metade responde outra
   * já custou caro aqui duas vezes.
   *
   * `faturamento` é a exceção, e declarada: sai de `orders`, que não tem
   * sessão, então não há como recortar por campanha. Com filtro ligado ele
   * simplesmente não vai — mostrar o faturamento cheio ao lado de um funil
   * recortado faria parecer que aquela campanha faturou tudo aquilo.
   */
  @Get('funil')
  async funil(
    @Req() req: any,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('trafego') trafego?: string,
    @Query('plataforma') plataforma?: string,
    @Query('campanha') campanha?: string,
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');

    const fim = this.fimDoDia(ate) ?? this.fimDoDia(this.hoje())!;
    const inicio = this.inicioDoDia(de) ?? new Date(fim.getTime() - 29 * 24 * 60 * 60 * 1000);

    // Valor fora da lista vira "tudo" em vez de 400: relatório que devolve erro
    // por causa de um link velho é relatório que atrapalha.
    const seg: Segmento = {
      trafego: (TRAFEGOS as readonly string[]).includes(trafego ?? '')
        ? (trafego as Trafego)
        : null,
      plataforma: plataforma?.trim() || null,
      campanha: campanha?.trim() || null,
    };
    const filtrado = Boolean(seg.trafego || seg.plataforma || seg.campanha);

    // Os anúncios marcados como "de lojas" (dono, 19/08): lidos UMA vez e
    // passados a todas as queries que recortam esse público — funil, jornada
    // e o quadro do tráfego de lojas leem a mesma lista, senão a tela se
    // contradiz (sessão fora do funil num quadro e dentro no outro).
    const campanhasDeLojas = await this.service.campanhasDeLojas();

    const [etapas, diagnosticos, faturamento, alertasCheckout, trafegoLojas, jornadaCompra, segmentos] =
      await Promise.all([
        this.service.funil(inicio, fim, seg, campanhasDeLojas),
        this.service.diagnosticosFunil(inicio, fim, seg),
        filtrado ? Promise.resolve(undefined) : this.service.faturamentoSite(inicio, fim),
        this.service.alertasCheckout(inicio, fim, seg),
        // Quem entrou pela /lojas (ou veio de anúncio de lojas) saiu do funil
        // acima — este é o quadro dela.
        this.service.trafegoDeLojas(inicio, fim, seg, campanhasDeLojas),
        this.service.jornadaCompra(inicio, fim, seg, campanhasDeLojas),
        // As opções da cascata saem do período INTEIRO, nunca do recorte atual:
        // se saíssem do recorte, escolher uma campanha apagaria as outras da
        // lista e não teria como voltar.
        this.service.segmentosDisponiveis(inicio, fim),
      ]);
    return {
      de: inicio.toISOString(),
      ate: fim.toISOString(),
      segmento: seg,
      segmentos,
      /**
       * QUAIS PLATAFORMAS TÊM ESPELHO DE GASTO LIGADO.
       *
       * Sem isto a tela não consegue distinguir "esta campanha não gastou
       * nada" de "ninguém configurou a credencial desta plataforma", e as duas
       * saem na tela como a mesma coisa: uma pílula sem ROAS. Foi exatamente
       * assim que o Google passou meses parecendo campanha sem retorno quando
       * na verdade era integração que não existia.
       */
      gastoConfigurado: {
        meta: this.metaAds.configurado(),
        google: this.googleAds.configurado(),
      },
      campanhasDeLojas,
      etapas,
      diagnosticos,
      faturamento,
      alertasCheckout,
      trafegoLojas,
      ...jornadaCompra,
    };
  }

  /**
   * QUAIS ANÚNCIOS SÃO "DE LOJAS" — a lista que o dono mantém na tela.
   *
   * Sessão que veio de uma campanha daqui é tratada como tráfego de lojas
   * (fora do funil do site, dentro do quadro "o que ele converte") mesmo
   * entrando pela home. Substitui a lista inteira a cada salvamento: é um
   * punhado de nomes, e "lista = o que está na tela" é mais fácil de confiar
   * que adicionar/remover um a um.
   */
  @Post('campanhas-lojas')
  async salvarCampanhasLojas(@Req() req: any, @Body() body: { campanhas?: string[] }) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    const campanhas = await this.service.salvarCampanhasDeLojas(body?.campanhas);
    return { campanhas };
  }

  private hoje(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * "2026-08-13" → 00:00 e 23:59:59.999 no fuso de SÃO PAULO, não em UTC.
   *
   * `new Date('2026-08-13')` no Node é meia-noite UTC = 21h do dia ANTERIOR
   * aqui. Filtrar "hoje" assim come as 3 primeiras horas do dia e mostra 3
   * horas do dia anterior — o mesmo erro de fuso que já apareceu na tela de
   * devolução do PDV. O deslocamento entra explícito.
   */
  private inicioDoDia(valor?: string): Date | null {
    if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return null;
    return new Date(`${valor}T00:00:00.000-03:00`);
  }

  private fimDoDia(valor?: string): Date | null {
    if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return null;
    return new Date(`${valor}T23:59:59.999-03:00`);
  }
}
