import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PedidoEmailService } from './pedido-email.service';

/**
 * RESGATE DO PIX NÃO PAGO (dono, 14/08/2026).
 *
 * A medição que motivou: 4 pedidos do site novo em 7 dias morreram em
 * `awaiting_payment` — cliente que preencheu identificação, endereço e frete,
 * gerou o PIX e sumiu. Nenhuma mensagem ia atrás: o fluxo "Pedido Pago" do
 * n8n ignora pedido não pago DE PROPÓSITO, o Reportana (que fazia esse
 * resgate no site antigo) está desligado desde 18/06, e não existia gatilho.
 *
 * Este cron é o gatilho — e SÓ o gatilho: acha o pedido PIX com 30min de
 * silêncio, avisa o n8n (`evento: 'pix_nao_pago'`, com o copia-e-cola no
 * payload) e carimba. Quem escreve e envia a mensagem é o n8n, que é o dono
 * da conversa (decisão do dono, 12/08).
 *
 * Regras que não se negociam:
 *  - UM toque por pedido, pra sempre (`pixResgateAvisadoEm`). Lembrete
 *    ajuda; o segundo lembrete é cobrança.
 *  - Só DENTRO da validade do PIX (o copia-e-cola de pedido vencido é
 *    convite pra pagar no vazio). A janela vai de `PIX_RESGATE_MIN` até a
 *    validade do QR — a MESMA `PIX_EXPIRA_MIN` que a criação do PIX usa
 *    (`LojaOrdersService`, 24h desde 16/08). Até 17/08 a validade estava
 *    chumbada aqui em 120min, sobra da época do PIX de 2h: quando a
 *    validade subiu pra 24h o cron não acompanhou e o único resgate morria
 *    2h depois de um PIX que ainda valia 22h.
 *  - Carimba SÓ depois do n8n aceitar o POST — rede falhou, tenta no ciclo
 *    seguinte; a janela limita a insistência sozinha.
 *  - Pedido que pagou entre a busca e o toque não recebe (recheca `paidAt`).
 *
 * Kill-switch: `PIX_RESGATE=0`. Ajuste fino: `PIX_RESGATE_MIN` (default 30).
 */
@Injectable()
export class PixResgateCron {
  private readonly logger = new Logger(PixResgateCron.name);

  private rodando = false;

  private static readonly MAX_POR_CICLO = 20;

  /**
   * Quanto tempo separa dois checkouts da MESMA compra. Os dois casos reais
   * (LP-001039 em 31/08 e LP-000285 em 27/08) refizeram em 5 minutos; 2h é
   * folga pra cliente que sai, resolve com o banco e volta — sem alcançar a
   * compra que ela fez de novo outro dia.
   */
  private static readonly JANELA_GEMEO_MS = 2 * 60 * 60 * 1000;

  /**
   * Validade do PIX da Pagar.me — depois disso o código morreu.
   *
   * MESMA env e MESMA expressão de `LojaOrdersService.PIX_EXPIRA_MIN`
   * (loja-orders.service.ts), que é quem manda `expiresInMinutes` pra
   * Pagar.me. Não é constante estática de propósito: lida a cada ciclo,
   * pra que mudar a env no Railway (que reinicia o app) e o teste que
   * mexe em `process.env` enxerguem o valor novo. Se um dia isso virar
   * constante compartilhada, trocar AQUI e lá juntos — divergir os dois é
   * exatamente o que aconteceu entre 16/08 e 17/08.
   */
  private get validadeMin(): number {
    return Number(process.env.PIX_EXPIRA_MIN) || 1440;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly pedidoEmail: PedidoEmailService,
  ) {}

  private get ligado(): boolean {
    return String(this.config.get<string>('PIX_RESGATE') ?? '1') !== '0';
  }

  private get esperaMin(): number {
    const n = Number(this.config.get<string>('PIX_RESGATE_MIN'));
    return Number.isFinite(n) && n >= 5 ? n : 30;
  }

  @Cron('30 */5 * * * *')
  async ciclo(): Promise<void> {
    if (!this.ligado || this.rodando) return;
    this.rodando = true;
    try {
      await this.varrer();
    } catch (e: any) {
      this.logger.warn(`[pix-resgate] ciclo falhou: ${e?.message ?? e}`);
    } finally {
      this.rodando = false;
    }
  }

  private async varrer(): Promise<void> {
    const agora = Date.now();
    const esperaMin = this.esperaMin;
    const validadeMin = this.validadeMin;

    // Janela invertida = `PIX_RESGATE_MIN` maior ou igual à validade do PIX
    // (ex.: alguém sobe a espera pra 180 com o PIX de 120). O `findMany`
    // abaixo ficaria com `gte > lte`, acharia zero pedidos e o cron pararia
    // de resgatar EM SILÊNCIO — o mesmo defeito que este cron existe pra
    // evitar. Avisa alto e não varre; corrige-se na env, não aqui.
    if (esperaMin >= validadeMin) {
      this.logger.warn(
        `[pix-resgate] janela invertida: PIX_RESGATE_MIN=${esperaMin} >= validade do PIX ${validadeMin}min (PIX_EXPIRA_MIN) — nada varrido`,
      );
      return;
    }

    const fimJanela = new Date(agora - esperaMin * 60_000);
    // Limite inferior FICA NO BANCO (createdAt >= agora − validade), não em
    // memória: a busca traz no máximo 100 linhas em ordem de criação e só
    // filtra o consentimento depois do parse — sem esse piso, os pedidos
    // velhos sem opt-in (a maioria) ocupariam as 100 vagas pra sempre e os
    // novos nunca chegariam ao toque. O `expiresAt` real de cada PIX é
    // conferido em memória logo antes de tocar (`pixAindaVale`).
    const inicioJanela = new Date(agora - validadeMin * 60_000);

    const pendentes = await (this.prisma as any).order.findMany({
      where: {
        source: 'ecommerce',
        status: 'awaiting_payment',
        paidAt: null,
        pixResgateAvisadoEm: null,
        createdAt: { gte: inicioJanela, lte: fimJanela },
        // Só PIX: cartão recusado é outro fluxo (a cliente já viu o erro na
        // tela na hora — lembrete de cartão não resgata, constrange).
        //
        // `"method":"pix"` e não `"pix"` (17/08): o cartão EM ANÁLISE agora
        // fica `awaiting_payment` e o paymentInfo dele é
        // `{"method":"card",...,"pix":null,"cartaoEmAnalise":true}` — a
        // substring `"pix"` casava com o `"pix":null` e a cliente que já tinha
        // pago no cartão recebia "seu Pix está esperando". `JSON.stringify`
        // não põe espaço depois dos dois-pontos, então a chave casa em pedido
        // novo e antigo. `pixAindaVale` reforça pelo lado de dentro.
        paymentInfo: { contains: '"method":"pix"' },
      },
      include: { items: true },
      orderBy: { createdAt: 'asc' },
      // O consentimento mora no trackingInfo (JSON em texto), então o banco
      // não filtra com segurança. Busca uma folga e limita depois do parse.
      take: PixResgateCron.MAX_POR_CICLO * 5,
    });
    if (!pendentes.length) return;

    const consentidos = pendentes
      .filter((pedido: any) => this.temConsentimento(pedido.trackingInfo))
      // O piso por `createdAt` é aproximação: se a env baixou depois de o
      // PIX nascer (ou a Pagar.me devolveu outro `expiresAt`), o pedido
      // ainda cabe na busca com o código já morto. Vencido não recebe
      // toque — e não gasta vaga do ciclo.
      .filter((pedido: any) => this.pixAindaVale(pedido.paymentInfo, agora))
      .slice(0, PixResgateCron.MAX_POR_CICLO);

    for (const pedido of consentidos) {
      // O reconcile de 1min pode ter confirmado o pagamento entre a busca e
      // este toque — mandar "seu PIX está esperando" pra quem JÁ PAGOU é o
      // jeito mais rápido de a cliente desconfiar da loja inteira.
      const fresco = await (this.prisma as any).order.findUnique({
        where: { id: pedido.id },
        select: { paidAt: true, status: true },
      });
      if (fresco?.paidAt || fresco?.status !== 'awaiting_payment') continue;

      /**
       * ...E O PAGAMENTO PODE TER ENTRADO NO PEDIDO GÊMEO (31/08).
       *
       * O guard acima cobre "pagou ESTE pedido". Falta o que aconteceu de
       * verdade com a Rosana (LP-001039, 31/08): ela abriu o checkout, não
       * pagou aquele QR, REFEZ 5 minutos depois e pagou o segundo
       * (LP-001041, 00:55). Às 01:20 o cron olhou o primeiro — sozinho,
       * ainda `awaiting_payment` — e mandou "seu PIX não foi pago" pra uma
       * cliente que tinha pago 25 minutos antes. Ela respondeu com o
       * comprovante, e a loja passou a tarde tentando casar aquele
       * comprovante com o pedido errado (o gêmeo já estava até enviado).
       *
       * Não é caso isolado: a mesma coisa com a LP-000285 em 27/08, também
       * ~26 min depois de pagar. São os 30min de espera do resgate caindo
       * exatamente na janela em que a cliente refaz a compra.
       *
       * Assinatura do checkout refeito, e só ela: MESMA cliente, MESMO
       * valor, criados a menos de 2h um do outro. Cliente que faz dois
       * pedidos DIFERENTES no mesmo dia continua recebendo o resgate — é a
       * venda que o cron existe pra salvar.
       */
      if (await this.clienteJaPagouOGemeo(pedido)) continue;

      const entregue = await this.pedidoEmail.aoPixNaoPago(pedido);
      if (!entregue) continue; // rede/n8n fora — o próximo ciclo tenta de novo

      await (this.prisma as any).order.update({
        where: { id: pedido.id },
        data: { pixResgateAvisadoEm: new Date() },
      });
      this.logger.log(
        `[pix-resgate] toque enviado — pedido ${pedido.wcOrderNumber ?? pedido.id} (R$ ${pedido.totalAmount ?? '?'})`,
      );
    }
  }

  /**
   * A cliente já pagou um pedido GÊMEO deste? (checkout refeito)
   *
   * Casa por CPF quando existe, senão por telefone — o pedido do site pode
   * chegar sem CPF, e aí o telefone é o que a cliente repete no segundo
   * checkout. Sem nenhum dos dois não dá pra afirmar que é a mesma pessoa, e
   * na dúvida o toque SAI (perder o resgate é venda perdida certa).
   *
   * NÃO carimba `pixResgateAvisadoEm` ao pular: o campo significa "o toque
   * foi entregue", e aqui ele não foi. O fantasma sai da fila sozinho quando
   * o PIX vence — o piso da busca é a validade do código.
   */
  private async clienteJaPagouOGemeo(pedido: any): Promise<boolean> {
    const cpf = String(pedido?.customerCpf || '').replace(/\D/g, '');
    const fone = String(pedido?.customerPhone || '').replace(/\D/g, '');
    const quem = cpf ? { customerCpf: pedido.customerCpf } : fone ? { customerPhone: pedido.customerPhone } : null;
    if (!quem) return false;
    if (pedido?.totalAmount == null) return false;

    const nascimento = new Date(pedido.createdAt).getTime();
    const gemeo = await (this.prisma as any).order
      .findFirst({
        where: {
          ...quem,
          id: { not: pedido.id },
          paidAt: { not: null },
          totalAmount: pedido.totalAmount,
          createdAt: {
            gte: new Date(nascimento - PixResgateCron.JANELA_GEMEO_MS),
            lte: new Date(nascimento + PixResgateCron.JANELA_GEMEO_MS),
          },
        },
        select: { wcOrderNumber: true, paidAt: true },
      })
      .catch(() => null);
    if (!gemeo) return false;

    this.logger.log(
      `[pix-resgate] toque RETIDO — ${pedido.wcOrderNumber ?? pedido.id} (R$ ${pedido.totalAmount}) é ` +
        `checkout refeito: a cliente já pagou ${gemeo.wcOrderNumber ?? '(gêmeo)'}. ` +
        `Dizer "você não pagou" pra quem pagou é o jeito mais rápido de perder a confiança dela.`,
    );
    return true;
  }

  private temConsentimento(trackingInfo: unknown): boolean {
    if (typeof trackingInfo !== 'string' || !trackingInfo) return false;
    try {
      return JSON.parse(trackingInfo)?.recovery_consent === true;
    } catch {
      return false;
    }
  }

  /**
   * `paymentInfo.pix.expiresAt` (ISO gravado por `cobrarPix`) ainda no
   * futuro? Sem o campo ou com JSON quebrado responde SIM: quem barra o
   * vencido de verdade é o piso de `createdAt` na busca — esta checagem só
   * afina; falhar fechado aqui deixaria pedido antigo (sem `expiresAt`) sem
   * o único toque por causa de um campo que ele nunca teve.
   */
  private pixAindaVale(paymentInfo: unknown, agora: number): boolean {
    if (typeof paymentInfo !== 'string' || !paymentInfo) return true;
    try {
      const parsed = JSON.parse(paymentInfo);
      // Não é PIX (cartão em análise, `pix:null`) → não é deste cron. Segunda
      // barreira além do filtro do banco: falhar aqui é mandar "seu Pix está
      // esperando" pra quem pagou no cartão.
      if (parsed?.method && parsed.method !== 'pix') return false;
      if (parsed && 'pix' in parsed && !parsed.pix) return false;
      const expiraEm = parsed?.pix?.expiresAt;
      if (!expiraEm) return true;
      const ts = Date.parse(String(expiraEm));
      return Number.isNaN(ts) ? true : ts > agora;
    } catch {
      return true;
    }
  }
}
