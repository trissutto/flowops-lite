import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleAdsService } from './google-ads.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

/**
 * A VENDA VOLTA PRO GOOGLE PELO SERVIDOR — sem GA4 no meio.
 *
 * ── POR QUE ISTO PRECISOU EXISTIR ──
 *
 * Em 19/08/2026, às 09:00, a conta de e-commerce parou de registrar conversão.
 * As DUAS ações morreram no mesmo minuto: a `Compra [OK]`, disparada pelo Tag
 * Manager do WordPress (que morreu quando o site novo assumiu `lurds.com.br`),
 * e o import `[GA4] (web) purchase`, que é a ação PRINCIPAL da conta.
 * Resultado: dias de campanha em ROAS desejado otimizando às cegas, com a
 * entrega do Shopping caindo de 487 para 127 cliques/dia — o robô não corta o
 * gasto quando perde o sinal, corta a entrega.
 *
 * A medição dependia de uma corrente de três elos (site → GA4 → Ads) em que
 * ninguém avisa quando um elo arrebenta. Isto é o caminho curto.
 *
 * ── POR QUE NÃO DÁ PRA FAZER COM TAG NO NAVEGADOR ──
 *
 * `purchase` é `SERVER_ONLY_EVENTS` no site, e por dois bons motivos: evento de
 * compra disparado pelo navegador é forjável (há teste cobrindo), e o PIX é
 * pago horas depois, quando não existe mais navegador aberto.
 *
 * ── 🚨 A AÇÃO DE CONVERSÃO TEM QUE SER `UPLOAD_CLICKS` ──
 *
 * A doc é categórica: *"The conversion action must have a type of
 * UPLOAD_CLICKS."* Ação nascida de tag do site (gtag/GTM) tem `type=WEBPAGE` e
 * recusa **100%** do lote com `INVALID_CONVERSION_ACTION_TYPE` — não é "algumas
 * falham", é sempre, para sempre. E recusa aqui é SILENCIOSA: HTTP 200, com
 * `results` cheio de objetos vazios. De fora parece cron saudável.
 *
 * Por isso `garantirAcaoValida()` confere o tipo antes do primeiro upload e se
 * recusa a arrancar se estiver errado. Custa 1 operação e elimina a única
 * classe de erro aqui que não tem desfazer.
 *
 * A ação certa nasce em: Ferramentas → Conversões → Nova ação → **Importar** →
 * Outras fontes de dados ou CRM → Acompanhar conversões de cliques. É ação
 * NOVA: não dá pra converter nem reaproveitar a do gtag.
 *
 * ⚠️ Ação recém-criada só aceita upload **6 horas depois** de existir
 * (`TOO_RECENT_CONVERSION_ACTION`). Criar hoje, ligar amanhã.
 *
 * ── O QUE TORNA ISTO SEGURO DE RODAR ──
 *
 * · `orderId` em toda conversão: o Google deduplica por ele.
 * · `adsConversaoEnviadaEm` carimba o pedido — a garantia é NOSSA (mesma lição
 *   do outbox do PDV, que não confia no Giga).
 * · `partialFailure: true` e leitura POSICIONAL de `results`: só os índices que
 *   voltaram OK são carimbados.
 * · Recusa definitiva é gravada e o pedido SAI da fila. Sem isso, o retry
 *   eterno entope o lote e queima a cota diária do token — que é compartilhada
 *   com o espelho de gasto, então derrubaria a tela de ROAS junto.
 * · Carência de 6h desde o pagamento: o Google recusa clique com menos de 6h
 *   (`TOO_RECENT_EVENT`), e a compra de mesma sessão é a maioria do tráfego
 *   pago. Sem o piso, o log encheria de recusa que não é problema — e log que
 *   grita à toa treina todo mundo a ignorar o log.
 * · Sem credencial ou sem `GOOGLE_ADS_CONVERSAO_ACTION_ID`, não roda.
 */
@Injectable()
export class GoogleAdsConversaoService {
  private readonly logger = new Logger(GoogleAdsConversaoService.name);

  /** Teto de tentativas antes de desistir de um pedido. */
  private readonly MAX_TENTATIVAS = 5;

  /** O Google recusa clique com menos de 6h. Piso de idade da nossa fila. */
  private readonly CARENCIA_MS = 6 * 60 * 60 * 1000;

  /** Cache do check de tipo: null = ainda não conferido nesta instância. */
  private acaoValida: boolean | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ads: GoogleAdsService,
    private readonly whats: WhatsappService,
  ) {}

  /**
   * ALARME DE SILÊNCIO — 10h BRT (13h UTC no Railway).
   *
   * A quebra de 19/08/2026 durou **10 dias** por um motivo só: nada avisa
   * quando a medição para. O gasto continua saindo normal, o status da ação de
   * conversão continua escrito "Ativa" e o total do período continua grande
   * (é histórico). Só "Última conversão registrada" denuncia, e ninguém abre
   * essa tela todo dia.
   *
   * São três perguntas, e qualquer uma respondida errado vira mensagem:
   *
   *  1. **A fila anda?** Tem pedido elegível esperando e nenhuma conversão
   *     aceita em 24h → o upload parou (token, cota, ação trocada).
   *  2. **O `gclid` ainda é gravado?** Pedido do Google chegando sem ele → a
   *     captura no checkout quebrou, e o upload fica sem matéria-prima.
   *  3. **O dinheiro sai e ninguém chega?** Gasto ontem sem um único pedido
   *     com UTM do Google → é a assinatura da migração de domínio que apagou
   *     o rastreamento.
   *
   * Sem `GOOGLE_ADS_ALERTA_WHATS` só loga — ninguém é acordado por engano.
   */
  @Cron('0 13 * * *', { name: 'google-ads-conversao-silencio' })
  async alertaSilencio(): Promise<void> {
    try {
      const problemas = await this.diagnosticarSilencio();
      if (!problemas.length) {
        this.logger.log('[google-ads] alarme de silêncio: medição de compra saudável 🎉');
        return;
      }

      const texto =
        '🚨 GOOGLE ADS — a medição de compra pode ter parado:\n\n' +
        problemas.map((p) => `• ${p}`).join('\n') +
        '\n\nConfira "Última conversão registrada" da ação principal em ' +
        'Ferramentas → Conversões. Com o sinal cortado o robô não corta o ' +
        'gasto: ele corta a ENTREGA da campanha que mais vende.';

      const destinos = String(process.env.GOOGLE_ADS_ALERTA_WHATS || '')
        .split(',')
        .map((n) => n.replace(/\D/g, ''))
        .filter((n) => n.length >= 10);

      if (!destinos.length) {
        this.logger.error(`[google-ads] ${problemas.join(' | ')} (GOOGLE_ADS_ALERTA_WHATS vazia — só log)`);
        return;
      }
      for (const numero of destinos) {
        const r = await this.whats
          .sendText(numero, texto)
          .catch((e: any) => ({ ok: false, error: e?.message }));
        if (!(r as any)?.ok) {
          this.logger.warn(`[google-ads] alarme não saiu pra ${numero}: ${(r as any)?.error}`);
        }
      }
    } catch (e: any) {
      // Alarme que derruba processo é pior que alarme que não toca.
      this.logger.warn(`[google-ads] alarme de silêncio falhou: ${e?.message || e}`);
    }
  }

  /**
   * As três perguntas do alarme, em SQL. Devolve a lista de problemas em
   * português — vazia quando está tudo de pé. Exposta para a rota de
   * diagnóstico poder responder a mesma coisa sob demanda.
   */
  async diagnosticarSilencio(): Promise<string[]> {
    const problemas: string[] = [];
    const agora = Date.now();
    const desde24h = new Date(agora - 24 * 3600 * 1000);
    const order = (this.prisma as any).order;

    // 1. Fila parada.
    const [aceitas, naFila] = await Promise.all([
      order.count({ where: { adsConversaoEnviadaEm: { gte: desde24h } } }),
      order.count({
        where: {
          source: 'ecommerce',
          paidAt: {
            not: null,
            lte: new Date(agora - this.CARENCIA_MS),
            gte: new Date(agora - 60 * 24 * 3600 * 1000),
          },
          status: { notIn: ['cancelled', 'failed'] },
          gclid: { not: null },
          adsConversaoEnviadaEm: null,
          adsConversaoTentativas: { lt: this.MAX_TENTATIVAS },
        },
      }),
    ]);
    if (naFila > 0 && aceitas === 0) {
      problemas.push(`${naFila} venda(s) esperando na fila e NENHUMA aceita pelo Google em 24h`);
    }

    // 2. `gclid` sumiu do checkout.
    const [googleComGclid, googleTotal] = await Promise.all([
      order.count({
        where: { source: 'ecommerce', paidAt: { gte: desde24h }, gclid: { not: null } },
      }),
      order.count({
        where: {
          source: 'ecommerce',
          paidAt: { gte: desde24h },
          utmSource: { contains: 'google', mode: 'insensitive' },
        },
      }),
    ]);
    if (googleTotal >= 3 && googleComGclid === 0) {
      problemas.push(
        `${googleTotal} venda(s) com UTM do Google em 24h e nenhuma trouxe gclid — a captura do checkout quebrou`,
      );
    }

    // 3. Gastou e ninguém chegou.
    const gasto = await this.prisma.$queryRawUnsafe<Array<{ gasto: number }>>(
      `SELECT COALESCE(SUM(gasto), 0)::float AS gasto FROM google_ads_gasto_dia
        WHERE dia = (CURRENT_DATE - INTERVAL '1 day')::date`,
    );
    const gastoOntem = Number(gasto?.[0]?.gasto || 0);
    if (gastoOntem > 100 && googleTotal === 0) {
      problemas.push(
        `R$ ${gastoOntem.toFixed(2)} gastos ontem e nenhuma venda chegou marcada como Google — rastreamento cortado`,
      );
    }

    // 4. A ação de conversão em si.
    if (this.acaoValida === false) {
      problemas.push('a ação de conversão configurada não é UPLOAD_CLICKS (nenhum upload é aceito)');
    }
    return problemas;
  }

  private env(nome: string): string | null {
    return this.config.get<string>(nome)?.trim() || null;
  }

  /** Conta dona da AÇÃO de conversão. Sem ela, cai na primeira de `GOOGLE_ADS_CONTAS`. */
  private conta(): string | null {
    const propria = this.env('GOOGLE_ADS_CONVERSAO_CONTA')?.replace(/\D/g, '');
    if (propria) return propria;
    return (
      (this.config.get<string>('GOOGLE_ADS_CONTAS') || '')
        .split(',')
        .map((c) => c.trim().replace(/\D/g, ''))
        .filter(Boolean)[0] ?? null
    );
  }

  /**
   * Id da ação de conversão do tipo **UPLOAD_CLICKS**.
   *
   * ⚠️ NÃO é a ação do gtag/GTM. A `Compra [OK]` (6807548872) desta conta é
   * `type=WEBPAGE` e recusa todo upload — ver o cabeçalho desta classe.
   */
  private acaoId(): string | null {
    return this.env('GOOGLE_ADS_CONVERSAO_ACTION_ID')?.replace(/\D/g, '') || null;
  }

  configurado(): boolean {
    return Boolean(
      this.ads.configurado() &&
        this.conta() &&
        this.acaoId() &&
        this.config.get<string>('GOOGLE_ADS_CONVERSAO_UPLOAD') !== '0',
    );
  }

  /**
   * De hora em hora, não de 10 em 10 minutos.
   *
   * O Google leva horas pra refletir a conversão no relatório e o lance dele
   * reaprende em dias — pressa aqui não compra nada. E o teto de operações do
   * token é compartilhado com o espelho de gasto: cada ciclo a mais é cota a
   * menos pra tela de ROAS. Minuto 37 pra não colidir com o 7 (Meta) nem com o
   * 17 (gasto do Google).
   */
  @Cron('37 * * * *')
  async cronEnviar(): Promise<void> {
    if (!this.configurado()) return;
    try {
      const r = await this.enviarPendentes();
      if (r.enviadas > 0 || r.recusadas > 0) {
        this.logger.log(
          `conversões: ${r.enviadas} aceita(s), ${r.recusadas} recusada(s) pelo Google`,
        );
      }
    } catch (err) {
      // Nunca lança: métrica não derruba processo.
      this.logger.error(`falha ao enviar conversão ao Google: ${String(err)}`);
    }
  }

  /**
   * CONFERE O TIPO DA AÇÃO ANTES DO PRIMEIRO UPLOAD.
   *
   * Uma operação, uma vez por processo. Sem ela, apontar a env pra ação errada
   * produz um cron que roda, responde 200 e não entrega nada — o modo de falha
   * mais caro que existe, porque parece sucesso.
   */
  private async garantirAcaoValida(conta: string, acao: string): Promise<boolean> {
    if (this.acaoValida !== null) return this.acaoValida;

    try {
      const corpo = await this.ads.requisitar(`customers/${conta}/googleAds:searchStream`, {
        query:
          'SELECT conversion_action.id, conversion_action.type, conversion_action.status ' +
          `FROM conversion_action WHERE conversion_action.id = ${acao}`,
      });
      const lotes: Array<{ results?: any[] }> = Array.isArray(corpo) ? corpo : [corpo];
      const linha = lotes.flatMap((l) => l?.results ?? [])[0];
      const tipo = linha?.conversionAction?.type;

      if (!linha) {
        this.logger.error(
          `ação de conversão ${acao} não existe na conta ${conta} — confira GOOGLE_ADS_CONVERSAO_ACTION_ID`,
        );
        this.acaoValida = false;
        return false;
      }
      if (tipo !== 'UPLOAD_CLICKS') {
        this.logger.error(
          `ação de conversão ${acao} é do tipo ${tipo}, e o upload exige UPLOAD_CLICKS. ` +
            'Crie em Ferramentas > Conversões > Nova ação > Importar > Outras fontes de dados ' +
            'ou CRM > Acompanhar conversões de cliques, e aponte a env pra ela. ' +
            'A ação do gtag/GTM NÃO serve.',
        );
        this.acaoValida = false;
        return false;
      }
      this.acaoValida = true;
      return true;
    } catch (err) {
      // Falha de rede não é veredito: não cacheia, tenta de novo no próximo ciclo.
      this.logger.warn(`não deu pra conferir o tipo da ação de conversão: ${String(err)}`);
      return false;
    }
  }

  /**
   * Sobe as vendas pagas que o Google ainda não contou.
   *
   * `validar = true` usa `validateOnly` da API: o Google confere tudo e não
   * grava nada. É o único jeito de descobrir sem sujar a conta se o token e a
   * ação estão certos. ⚠️ Com `validateOnly`, `results` vem VAZIO de propósito
   * — não confundir com falha, e por isso nada é carimbado nesse modo.
   */
  async enviarPendentes(
    limite = 200,
    validar = false,
  ): Promise<{ enviadas: number; recusadas: number; validado?: number; erro?: string }> {
    if (!this.configurado()) return { enviadas: 0, recusadas: 0 };

    const conta = this.conta()!;
    const acaoId = this.acaoId()!;
    if (!(await this.garantirAcaoValida(conta, acaoId))) {
      return { enviadas: 0, recusadas: 0, erro: 'ação de conversão inválida (ver log)' };
    }

    const agora = Date.now();
    const pedidos = await (this.prisma as any).order.findMany({
      where: {
        source: 'ecommerce',
        // PROVA DE PAGAMENTO, não lista de status. O enum não tem 'paid' nem
        // 'completed' (`common/enums.ts`): quem paga vira 'processing', e só
        // depois de um humano rotear é que vira 'separating'. Filtrar por
        // status deixaria de fora justamente o pedido recém-pago — e a janela
        // de 60 dias o faria expirar sem nunca ter sido tentado.
        paidAt: {
          not: null,
          // Carência de 6h: o Google recusa clique mais novo que isso.
          lte: new Date(agora - this.CARENCIA_MS),
          // Fora da janela não adianta mais tentar.
          gte: new Date(agora - 60 * 24 * 60 * 60 * 1000),
        },
        status: { notIn: ['cancelled', 'failed'] },
        // ANTES exigia `gclid: { not: null }` — e era esse AND que fazia 9 de
        // cada 10 compras nunca chegarem ao Google. Agora basta ter ALGUMA
        // chave: o clique, ou a pessoa (e-mail/telefone hasheado). Pedido sem
        // nenhuma das duas continua de fora — a API recusa evento sem
        // identificador, e mandar assim derrubaria o lote inteiro.
        OR: [
          { gclid: { not: null } },
          { customerEmail: { not: null } },
          { customerPhone: { not: null } },
        ],
        adsConversaoEnviadaEm: null,
        adsConversaoTentativas: { lt: this.MAX_TENTATIVAS },
      },
      select: {
        id: true,
        wcOrderNumber: true,
        gclid: true,
        customerEmail: true,
        customerPhone: true,
        totalAmount: true,
        paidAt: true,
        adsConversaoTentativas: true,
      },
      orderBy: { paidAt: 'asc' },
      // Teto da API é 2.000 por request.
      take: Math.min(limite, 2000),
    });
    if (!pedidos.length) return { enviadas: 0, recusadas: 0 };

    // O DESTINO carrega a conta e a ação; na Data Manager não existe
    // `conversionAction` por evento como no caminho antigo.
    const mcc = this.env('GOOGLE_ADS_LOGIN_CUSTOMER_ID')?.replace(/\D/g, '');
    const destino: Record<string, unknown> = {
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: conta },
      productDestinationId: acaoId,
    };
    // Só vai quando existe: `loginAccount` de um MCC que não é pai da conta é
    // erro de permissão, não campo ignorado.
    if (mcc) destino.loginAccount = { accountType: 'GOOGLE_ADS', accountId: mcc };

    // Pedido que não rende identificador nenhum sai FORA do lote: a Data
    // Manager recusa o evento e, como o ingest é tudo-ou-nada, um pedido sem
    // chave levaria junto todos os outros do lote.
    const enviaveis: any[] = [];
    const semChave: any[] = [];
    for (const p of pedidos) {
      const userData = this.identificadoresDe(p);
      if (!p.gclid && !userData) semChave.push(p);
      else enviaveis.push({ pedido: p, userData });
    }
    if (semChave.length) {
      this.logger.warn(
        `${semChave.length} pedido(s) fora do lote: sem gclid e sem e-mail/telefone válidos`,
      );
    }
    if (!enviaveis.length) return { enviadas: 0, recusadas: 0 };

    const eventos = enviaveis.map(({ pedido: p, userData }: any) => ({
      // O clique quando existe; a pessoa sempre que der. Os dois juntos é o
      // caso de melhor casamento — confirmado aceito pela API.
      ...(p.gclid ? { adIdentifiers: { gclid: p.gclid } } : {}),
      ...(userData ? { userData } : {}),
      // A hora da CONVERSÃO é a do pagamento — o PIX pago no dia seguinte
      // pertence ao dia seguinte. Aqui o formato é RFC 3339, com 'T'; o
      // caminho antigo exigia espaço. Trocar um pelo outro é 400.
      eventTimestamp: this.momentoRfc3339(p.paidAt),
      conversionValue: Number(p.totalAmount) || 0,
      currency: 'BRL',
      eventSource: 'WEB',
      // A chave de deduplicação do lado do Google.
      transactionId: String(p.wcOrderNumber ?? p.id),
    }));

    const temUserData = eventos.some((e: any) => e.userData);

    let resposta: any;
    try {
      resposta = await this.ads.requisitarDataManager('events:ingest', {
        destinations: [destino],
        events: eventos,
        // 🚨 OBRIGATÓRIO quando vai `userData`: sem `encoding` a API devolve 400
        // seco mesmo com o hash correto. Medido com validateOnly em 02/09.
        ...(temUserData ? { encoding: 'HEX' } : {}),
        ...(validar ? { validateOnly: true } : {}),
      });
    } catch (err) {
      // O ingest é TUDO-OU-NADA: se caiu, nenhum pedido do lote subiu. Marcar
      // a tentativa e o motivo em cada um é o que faz o `MAX_TENTATIVAS` deixar
      // de ser código morto — sem isso um pedido que o Google recusa em
      // definitivo volta de hora em hora pra sempre, levando junto todo pedido
      // novo do lote, e ninguém fica sabendo.
      if (!validar) {
        const motivo = String((err as Error)?.message ?? err).slice(0, 500);
        await (this.prisma as any).order
          .updateMany({
            where: { id: { in: enviaveis.map((e: any) => e.pedido.id) } },
            data: { adsConversaoTentativas: { increment: 1 }, adsConversaoErro: motivo },
          })
          .catch(() => undefined); // registrar a falha não pode virar outra falha
      }
      throw err;
    }

    const avisos: any[] = Array.isArray(resposta?.fieldWarnings) ? resposta.fieldWarnings : [];

    if (validar) {
      // Nada é carimbado: o Google não gravou nada.
      return {
        enviadas: 0,
        recusadas: 0,
        validado: enviaveis.length,
        erro: avisos.length ? JSON.stringify(avisos).slice(0, 800) : undefined,
      };
    }

    // ⚠️ A Data Manager NÃO devolve resultado por evento: `IngestEventsResponse`
    // traz só `requestId` e `fieldWarnings`. É TUDO OU NADA — HTTP 200 quer
    // dizer lote aceito. A leitura posicional do caminho antigo não tem
    // equivalente aqui, e forjar uma seria carimbar como enviado o que o Google
    // não confirmou item a item.
    //
    // Consequência: falha da requisição inteira (rede, escopo, permissão) não
    // carimba nada e o lote volta na hora seguinte — `requisitarDataManager`
    // lança, e quem chama registra o erro.
    if (avisos.length) {
      this.logger.warn(
        `Data Manager aceitou o lote com ${avisos.length} aviso(s) de campo. ` +
          `Primeiro: ${JSON.stringify(avisos[0]).slice(0, 300)}`,
      );
    }

    await (this.prisma as any).order.updateMany({
      where: { id: { in: enviaveis.map((e: any) => e.pedido.id) } },
      data: { adsConversaoEnviadaEm: new Date(), adsConversaoErro: null },
    });

    // O pedido sem chave nenhuma NÃO some em silêncio: conta tentativa e grava
    // o motivo. Sem isso o `MAX_TENTATIVAS` era código morto (ele nunca subia)
    // e o pedido voltava na fila de hora em hora, pra sempre, sem rastro.
    if (semChave.length) {
      await (this.prisma as any).order.updateMany({
        where: { id: { in: semChave.map((p: any) => p.id) } },
        data: {
          adsConversaoTentativas: { increment: 1 },
          adsConversaoErro: 'sem gclid e sem e-mail/telefone válidos pra casar no Google',
        },
      });
    }

    const comPessoa = eventos.filter((e: any) => e.userData).length;
    const soPessoa = eventos.filter((e: any) => e.userData && !e.adIdentifiers).length;
    this.logger.log(
      `${enviaveis.length} conversão(ões) enviada(s) ao Google ` +
        `(${comPessoa} com identificador de pessoa, ${soPessoa} SEM gclid — só existiam ` +
        `por causa dele; requestId ${resposta?.requestId ?? '-'})`,
    );
    return { enviadas: enviaveis.length, recusadas: semChave.length };
  }

  /**
   * 'yyyy-MM-dd HH:mm:ss+/-HH:mm' — com ESPAÇO, não 'T'. `toISOString()` não
   * serve. O fuso é obrigatório: sem ele o Google assume o da conta e a venda
   * das 23h vira do dia seguinte.
   */
  /**
   * RFC 3339 — o que a Data Manager exige: 'yyyy-MM-ddTHH:mm:ss+/-HH:mm'.
   *
   * É o `momento()` com 'T' no lugar do espaço. Mantidos os dois de propósito:
   * o espaço era exigência do `uploadClickConversions` e a diferença entre um e
   * outro é um 400 seco, não um aviso.
   */
  private momentoRfc3339(d: Date): string {
    return this.momento(d).replace(' ', 'T');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  IDENTIFICADOR DA PESSOA (Enhanced Conversions) — 02/09/2026
  //
  //  O `gclid` some fácil: a cliente vê o anúncio no celular e compra no PC,
  //  manda o link pra amiga, volta dois dias depois por fora do anúncio. Medido
  //  em 30 dias: 363 pedidos pagos, só 38 (10,5%) com gclid — e mesmo entre os
  //  57 que a UTM marcou como Google, 19 (R$ 4.846,79) não tinham.
  //
  //  O e-mail/telefone hasheado é a segunda chave: o Google casa com o clique
  //  que ELE conhece. Não inventa conversão — pedido sem clique nenhum
  //  simplesmente não é atribuído.
  //
  //  ⚠️ Contrato confirmado contra a API real com `validateOnly` (02/09):
  //   · `userData.userIdentifiers` só é aceito com `encoding: 'HEX'` no TOPO da
  //     requisição. Sem isso: HTTP 400 seco, mesmo com o hash certo.
  //   · e-mail em texto puro é RECUSADO (o Google confere que é hash).
  //   · lote MISTO (uns com gclid+userData, outros só userData) é aceito.
  //   · evento sem identificador nenhum é recusado — por isso o filtro embaixo.
  // ═══════════════════════════════════════════════════════════════════════════

  private sha256Hex(v: string): string {
    return createHash('sha256').update(v).digest('hex');
  }

  /** Trim + minúscula, que é a canonicalização que o Google pede pra e-mail. */
  private hashEmail(email?: string | null): string | null {
    const limpo = String(email ?? '').trim().toLowerCase();
    // Validação mínima: hash de lixo casa com nada e ainda gasta cota.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(limpo)) return null;
    return this.sha256Hex(limpo);
  }

  /**
   * E.164. ⚠️ `Order.customerPhone` é gravado SEM DDI (o checkout já engoliu
   * dígito por causa disso uma vez) — então o 55 entra aqui, e só quando não
   * veio. Celular = DDD(2)+9 = 11 dígitos; fixo = DDD(2)+8 = 10.
   */
  private hashTelefone(fone?: string | null): string | null {
    let d = String(fone ?? '').replace(/\D/g, '');
    if (!d) return null;
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    if (d.length < 10 || d.length > 11) return null; // não é telefone BR válido
    return this.sha256Hex(`+55${d}`);
  }

  /** `userData` do pedido, ou null quando não há e-mail nem telefone usável. */
  private identificadoresDe(p: {
    customerEmail?: string | null;
    customerPhone?: string | null;
  }): { userIdentifiers: Array<Record<string, string>> } | null {
    const ids: Array<Record<string, string>> = [];
    const email = this.hashEmail(p.customerEmail);
    if (email) ids.push({ emailAddress: email });
    const fone = this.hashTelefone(p.customerPhone);
    if (fone) ids.push({ phoneNumber: fone });
    return ids.length ? { userIdentifiers: ids } : null;
  }

  private momento(d: Date): string {
    const opcoes: Intl.DateTimeFormatOptions = {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    };
    // 'sv-SE' já entrega 'YYYY-MM-DD HH:mm:ss' — o único locale que sai no
    // formato certo sem remontar string na mão.
    const local = new Intl.DateTimeFormat('sv-SE', opcoes).format(d).replace('T', ' ');

    // O deslocamento é PERGUNTADO, não chumbado. Hoje o Brasil não tem horário
    // de verão (acabou em 2019) e isto devolve sempre -03:00 — mas se voltar,
    // um `-03:00` fixo mandaria toda venda de verão uma hora errada, em
    // silêncio, e ninguém confere carimbo de conversão.
    const nome = new Intl.DateTimeFormat('en-US', { ...opcoes, timeZoneName: 'longOffset' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value; // ex.: 'GMT-03:00'
    const offset = /GMT([+-]\d{2}:\d{2})/.exec(nome ?? '')?.[1] ?? '-03:00';

    return `${local}${offset}`;
  }
}
