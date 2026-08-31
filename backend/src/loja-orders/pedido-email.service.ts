import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { EmailService } from '../email/email.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { PrismaService } from '../prisma/prisma.service';
import { transportadoraParaCliente } from '../common/transportadora-cliente';

/**
 * A CAIXA do aviso de rastreio (28/08) — pedido fracionado despacha uma caixa
 * por loja e cada aviso diz qual caixa é e quais peças viajam nela.
 * Montada pelo afterShipped do pick-orders (`caixaDoAviso`).
 */
export interface CaixaAviso {
  posicao: number;
  total: number;
  itens: Array<{ nome: string; qty: number }>;
}

/**
 * O E-MAIL QUE A CLIENTE ESPERA — e que não existia (achado de 12/08/2026).
 *
 * Medido na revisão de prontidão do site: o pedido do e-commerce **não
 * disparava e-mail nenhum**. Nem "recebemos seu pedido", nem "pagamento
 * confirmado". A cliente pagava e ficava sem nada na caixa de entrada —
 * exatamente o silêncio que faz ela abrir um chamado, pedir estorno ou
 * simplesmente nunca mais comprar.
 *
 * Para tráfego pago isso é pior ainda: o anúncio traz gente que não conhece a
 * loja, e a primeira prova de que a compra deu certo é o e-mail.
 *
 * ── DECISÕES ──
 *
 * 1. **Nunca derruba a venda.** Todo envio é best-effort e engolido: o pedido
 *    já está pago no banco quando isto roda. Falha de SMTP não pode reverter
 *    dinheiro que entrou, e o log diz o que aconteceu.
 *
 * 2. **Sem SMTP configurado, avisa uma vez e segue.** O `EmailService`
 *    devolve `false` na primeira linha quando `SMTP_HOST/USER/PASS` faltam. O
 *    log aqui é explícito, porque "não chegou e-mail" e "não configuramos
 *    e-mail" são coisas diferentes e sem isto ninguém distingue.
 *
 * 3. **Texto sem promessa que a operação não cumpre.** Prazo de troca sai da
 *    política vigente (7 dias); nada de "chega em 2 dias" — o prazo real de
 *    entrega depende do frete escolhido e já foi mostrado no checkout.
 */

interface ItemDoEmail {
  nome: string;
  quantidade: number;
  valor?: number | null;
}

@Injectable()
export class PedidoEmailService {
  private readonly logger = new Logger(PedidoEmailService.name);

  /** Prazo de troca — o mesmo do portal (`TrocasService`, default 7). */
  private static readonly DIAS_TROCA = 7;

  /** Quantas lojas físicas aceitam a troca — o argumento que o site sozinho não tem. */
  private static readonly LOJAS_NA_REDE = 14;

  constructor(
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly whats: WhatsappService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * REGISTRA A SAÍDA (31/08) — ver o model `AvisoEnviado`.
   *
   * Regra única: **nunca derruba, nunca atrasa o envio**. Todo caminho está
   * dentro de try/catch e é chamado sem `await` — se o banco estiver fora, a
   * cliente ainda recebe a mensagem e a gente perde só a linha do log. O
   * contrário (log que impede o aviso) seria trocar um problema de auditoria
   * por um problema de atendimento.
   *
   * `ok` significa "o canal aceitou", não "a cliente leu": o n8n pode aceitar
   * o POST e o WhatsApp não entregar. `ok=false` é certeza de falha; `ok=true`
   * é o ponto até onde a gente enxerga.
   */
  private registrar(
    evento: string,
    canal: 'n8n' | 'whatsapp' | 'email' | 'regra',
    order: any,
    ok: boolean,
    destino?: string | null,
    erro?: string | null,
  ): void {
    try {
      void (this.prisma as any).avisoEnviado
        ?.create({
          data: {
            orderId: order?.id ? String(order.id) : null,
            wcOrderNumber: order?.wcOrderNumber ? String(order.wcOrderNumber) : null,
            evento: String(evento).slice(0, 40),
            canal,
            destino: destino ? String(destino).slice(0, 120) : null,
            ok,
            erro: erro ? String(erro).slice(0, 2000) : null,
          },
        })
        .catch((e: any) =>
          this.logger.warn(`[aviso-log] não registrou ${evento}/${canal}: ${e?.message || e}`),
        );
    } catch (e: any) {
      this.logger.warn(`[aviso-log] não registrou ${evento}/${canal}: ${e?.message || e}`);
    }
  }

  /**
   * WHATSAPP DIRETO — o plano B do n8n (liberado pelo dono, 14/08).
   *
   * O fluxo "Pedido Pago" decide com `status === 'processing'`, então só o
   * evento de PAGAMENTO vira mensagem: `pix_nao_pago`, `pedido_enviado` e
   * `pedido_entregue` chegam lá e são descartados pelo IF. Enquanto não
   * existirem ramos por `body.evento`, esses três saem por aqui — pelo mesmo
   * WhatsApp que o portal de trocas e o código de recuperação de senha já
   * usam em produção.
   *
   * ⚠️ NUNCA cobre `pagamento_confirmado`: esse o n8n já manda, e ligar os
   * dois entrega a mesma mensagem duas vezes — o defeito que a cliente lê
   * como "comprei duas vezes".
   *
   * Kill-switch `WHATS_PEDIDO_DIRETO=0`. Ao criar os ramos no n8n, desligar
   * aqui — senão a duplicidade volta pela outra ponta.
   */
  private get whatsDiretoLigado(): boolean {
    return String(this.config.get<string>('WHATS_PEDIDO_DIRETO') ?? '1') === '1';
  }

  private async avisarWhatsDireto(
    evento: 'pix_nao_pago' | 'pedido_enviado' | 'pedido_entregue',
    order: any,
    caixa?: CaixaAviso | null,
  ): Promise<boolean> {
    if (!this.whatsDiretoLigado) return false;
    const telefone = String(order?.customerPhone || '').replace(/\D/g, '');
    if (telefone.length < 10) return false;

    const nome = this.primeiroNome(order?.customerName);
    const numero = order?.wcOrderNumber ? ` ${order.wcOrderNumber}` : '';
    let texto: string | null = null;

    if (evento === 'pix_nao_pago') {
      const pix = this.pixDoPedido(order);
      if (!pix.copiaECola) return false; // sem o código a mensagem não serve pra nada
      const validade =
        pix.minutosRestantes && pix.minutosRestantes > 0
          ? `\nEle vale por mais ${pix.minutosRestantes} minutos.`
          : '';
      texto =
        `Oi, ${nome}! 💛\n\nSuas peças do pedido${numero} estão reservadas, mas o Pix ainda não caiu.${validade}\n\n` +
        `É só copiar o código abaixo e colar em "Pix copia e cola" no app do seu banco:\n\n${pix.copiaECola}\n\n` +
        `Se o Pix vencer, o pedido é liberado e as peças voltam pro estoque — nada é cobrado.`;
    } else if (evento === 'pedido_enviado') {
      const codigo = String(order?.trackingCode || '').trim();
      const transportadora = this.transportadoraParaCliente(order?.carrier);
      const link = this.linkRastreio(codigo, String(order?.carrier || 'Correios'));
      // FRACIONADO (28/08): cada caixa manda o próprio aviso, dizendo qual
      // caixa é, o que vem nela e que as outras têm código próprio — antes só
      // o primeiro código chegava e a cliente perguntava "cadê o resto?".
      const fracionado = (caixa?.total ?? 1) > 1;
      const intro = fracionado
        ? `Parte do seu pedido${numero} saiu pra entrega com a ${transportadora}! ` +
          `Suas peças vêm em ${caixa!.total} caixas — esta é a caixa ${caixa!.posicao} de ${caixa!.total}, ` +
          `e cada caixa tem o próprio código de rastreio (te aviso de cada uma por aqui).`
        : `Seu pedido${numero} saiu pra entrega com a ${transportadora}.`;
      texto =
        `Oi, ${nome}! 💛\n\n${intro}` +
        this.linhaItensCaixa(caixa) +
        (codigo ? `\n\n📦 Código: *${codigo}*` : '') +
        (link ? `\n${link}` : '');
    } else {
      const limite = new Date(Date.now() + PedidoEmailService.DIAS_TROCA * 24 * 60 * 60 * 1000);
      texto =
        `Oi, ${nome}! 💛\n\nOs Correios confirmaram a entrega do seu pedido${numero}. ` +
        `Esperamos que sirva certinho!\n\n` +
        `Se precisar trocar, você tem até ${limite.toLocaleDateString('pt-BR')} — pelo portal de trocas ` +
        `ou em qualquer uma das nossas ${PedidoEmailService.LOJAS_NA_REDE} lojas.`;
    }

    try {
      const r = await this.whats.sendText(telefone, texto);
      if (!r?.ok) {
        this.logger.warn(`[pedido-whats] ${evento} não saiu (pedido ${order?.wcOrderNumber}): ${r?.error}`);
      }
      this.registrar(evento, 'whatsapp', order, !!r?.ok, telefone, r?.ok ? null : r?.error);
      return !!r?.ok;
    } catch (e: any) {
      this.logger.warn(`[pedido-whats] ${evento} falhou (pedido ${order?.wcOrderNumber}): ${e?.message || e}`);
      this.registrar(evento, 'whatsapp', order, false, telefone, e?.message || String(e));
      return false;
    }
  }

  /**
   * ── O n8n É O DONO DA CONVERSA (decisão do dono, 12/08/2026) ──
   *
   * "aquela estrutura de whats funciona bem e a de email também funcionava lá".
   * O fluxo do n8n já manda WhatsApp e e-mail para o pedido do site ANTIGO, e
   * reconstruir isso aqui seria trocar o que funciona por código novo — e, pior,
   * fazer a cliente receber tudo em dobro durante a convivência.
   *
   * Então o backend novo só AVISA: dispara o mesmo evento pro webhook do n8n,
   * que continua sendo quem escreve e envia. É o gatilho que muda de dono (do
   * WooCommerce pro site novo), não o fluxo.
   *
   * `N8N_PEDIDO_WEBHOOK_URL` vazia = não dispara nada (é o estado de hoje,
   * enquanto a URL não é informada).
   */
  private get webhookN8n(): string {
    return String(this.config.get<string>('N8N_PEDIDO_WEBHOOK_URL') || '').trim();
  }

  /**
   * O e-mail PRÓPRIO (este serviço) é o plano B, DESLIGADO por padrão.
   *
   * Ligar os dois ao mesmo tempo entrega duas mensagens pra mesma compra, que
   * é pior que nenhuma: a cliente conclui que comprou duas vezes. Vale ligar
   * (`PEDIDO_EMAIL_PROPRIO=1`) só se o fluxo do n8n sair de cena.
   */
  private get emailProprioLigado(): boolean {
    return String(this.config.get<string>('PEDIDO_EMAIL_PROPRIO') ?? '0') === '1';
  }

  /**
   * Avisa o n8n. Fire-and-forget: automação de mensagem nunca desfaz
   * pagamento, e o log conta o que aconteceu.
   *
   * O payload leva o pedido inteiro em campos planos — o n8n é montado com
   * cliques, e obrigar quem edita o fluxo a cavar dentro de objeto aninhado é
   * o jeito mais rápido de o fluxo quebrar na primeira manutenção.
   */
  private async avisarN8n(
    evento: 'pedido_criado' | 'pagamento_confirmado' | 'pix_nao_pago' | 'pedido_enviado' | 'pedido_entregue',
    order: any,
    caixa?: CaixaAviso | null,
  ): Promise<boolean> {
    const url = this.webhookN8n;
    if (!url) {
      this.logger.debug(`[pedido-msg] ${evento} não disparado — N8N_PEDIDO_WEBHOOK_URL ausente`);
      // Registra o NÃO-envio: canal desconfigurado é a causa mais silenciosa
      // de "a cliente não recebeu", e é exatamente o que some do log.
      this.registrar(evento, 'n8n', order, false, null, 'N8N_PEDIDO_WEBHOOK_URL ausente');
      return false;
    }

    /**
     * ⚠️ O PAYLOAD IMITA O WOOCOMMERCE, e isso é o ponto (12/08/2026).
     *
     * Li o fluxo "Pedido Pago" direto no banco do n8n: ele decide com
     * `$json.body.status === 'processing'` e monta a mensagem com
     * `body.billing.first_name`, `body.billing.phone` e `body.id` — o formato
     * que o WooCommerce mandava.
     *
     * Falar essa mesma língua é o que permite REAPONTAR O GATILHO sem abrir o
     * fluxo: o que já funciona (a mensagem, o retry, a planilha) continua
     * intacto, e o site novo só passa a ser quem chama. Mudar o n8n pra
     * entender um formato novo seria mexer no que está de pé pra acomodar o
     * que acabou de nascer.
     *
     * `status: 'processing'` só vai no evento de PAGAMENTO — é ele que o `IF`
     * do fluxo exige. No `pedido_criado` o status vai como está, então o fluxo
     * ignora sozinho (o Pix ainda não foi pago; avisar "confirmado" ali seria
     * mentira).
     *
     * Os campos do Flow vão junto, fora do formato antigo: quem editar o fluxo
     * amanhã tem o pedido inteiro à mão sem precisar de outro webhook.
     */
    const pago = evento === 'pagamento_confirmado';
    const telefone = String(order?.customerPhone || '').replace(/\D/g, '');
    const nomeCompleto = String(order?.customerName || '').trim();
    const [primeiroNome, ...resto] = nomeCompleto.split(/\s+/);

    try {
      await firstValueFrom(
        this.http.post(
          url,
          {
            // ── formato que o fluxo já entende ──
            id: order?.wcOrderNumber ?? order?.id ?? null,
            status: pago ? 'processing' : String(order?.status || 'pending'),
            billing: {
              first_name: primeiroNome || 'cliente',
              last_name: resto.join(' '),
              // Sem o 55: o fluxo prefixa (`=55{{ ...phone }}`) e mandar o DDI
              // aqui produziria "5555…" e mensagem entregue a ninguém.
              phone: telefone.replace(/^55(?=\d{10,11}$)/, ''),
              email: order?.customerEmail ?? null,
            },
            total: order?.totalAmount ?? null,
            // ── o que é do Flow, pra quem editar o fluxo depois ──
            evento,
            origem: 'site-novo',
            pedido: {
              numero: order?.wcOrderNumber ?? null,
              id: order?.id ?? null,
              total: order?.totalAmount ?? null,
              statusFlow: order?.status ?? null,
              pagoEm: order?.paidAt ?? null,
              formaPagamento: String(order?.paymentInfo || '').includes('"pix"') ? 'pix' : 'cartao',
            },
            cliente: {
              nome: nomeCompleto || null,
              email: order?.customerEmail ?? null,
              telefone: telefone || null,
              cpf: order?.customerCpf ?? null,
            },
            itens: this.itensDoPedido(order),
            prazoTrocaDias: PedidoEmailService.DIAS_TROCA,
            // ── só no resgate: o código copia-e-cola VAI NA MENSAGEM ──
            // A cliente paga direto do WhatsApp, sem reabrir o site. É a
            // única saída do paymentInfo pra fora do backend, e o destino é
            // o n8n da casa — nunca o GET público.
            ...(evento === 'pix_nao_pago' ? { pix: this.pixDoPedido(order) } : {}),
            // ── só no envio: código e transportadora pro WhatsApp de rastreio ──
            ...(evento === 'pedido_enviado'
              ? {
                  rastreio: {
                    codigo: order?.trackingCode ?? null,
                    transportadora: this.transportadoraParaCliente(order?.carrier),
                    link: this.linkRastreio(order?.trackingCode, order?.carrier),
                    // FRACIONADO (28/08): qual caixa é esta e o que vem nela —
                    // o fluxo do n8n monta a mensagem por caixa.
                    caixa: caixa ? { posicao: caixa.posicao, total: caixa.total } : null,
                    itens: (caixa?.itens ?? []).map((i) => ({ nome: i.nome, qtd: i.qty })),
                  },
                }
              : {}),
          },
          { timeout: 12000 },
        ),
      );
      this.logger.log(`[pedido-msg] ${evento} entregue ao n8n (pedido ${order?.wcOrderNumber ?? order?.id})`);
      this.registrar(evento, 'n8n', order, true, telefone || null);
      return true;
    } catch (e: any) {
      const erro = `${e?.response?.status ?? ''} ${e?.message || e}`.trim();
      this.logger.warn(`[pedido-msg] n8n não recebeu ${evento}: ${erro}`);
      this.registrar(evento, 'n8n', order, false, telefone || null, erro);
      return false;
    }
  }

  /** Copia-e-cola e validade do PIX, lidos do paymentInfo do pedido. */
  private pixDoPedido(order: any): { copiaECola: string | null; expiraEm: string | null; minutosRestantes: number | null } {
    try {
      const info = JSON.parse(String(order?.paymentInfo || '{}'));
      const expiraEm = info?.pix?.expiresAt ?? null;
      const restam = expiraEm ? Math.max(0, Math.round((Date.parse(expiraEm) - Date.now()) / 60000)) : null;
      return { copiaECola: info?.pix?.copyPaste ?? null, expiraEm, minutosRestantes: restam };
    } catch {
      return { copiaECola: null, expiraEm: null, minutosRestantes: null };
    }
  }

  /** Nome amigável da transportadora — ver `common/transportadora-cliente`. */
  private transportadoraParaCliente(carrier?: string | null): string {
    return transportadoraParaCliente(carrier);
  }

  /** "O que vem nesta caixa" pro WhatsApp — até 6 peças, resto agregado. */
  private linhaItensCaixa(caixa?: CaixaAviso | null): string {
    const itens = caixa?.itens ?? [];
    if (!itens.length) return '';
    const titulo = (caixa?.total ?? 1) > 1 ? '\n\n👗 Nesta caixa:' : '\n\n👗 Suas peças:';
    const mostra = itens
      .slice(0, 6)
      .map((i) => `\n• ${i.qty > 1 ? `${i.qty}x ` : ''}${i.nome}`)
      .join('');
    const resto = itens.length - 6;
    return `${titulo}${mostra}${resto > 0 ? `\n• … e mais ${resto} peça(s)` : ''}`;
  }

  /** O mesmo bloco de peças, em HTML, pro e-mail. */
  private blocoItensCaixaHtml(caixa?: CaixaAviso | null): string {
    const itens = caixa?.itens ?? [];
    if (!itens.length) return '';
    const titulo = (caixa?.total ?? 1) > 1 ? 'Nesta caixa' : 'Suas peças';
    const linhas = itens
      .slice(0, 8)
      .map((i) => `• ${i.qty > 1 ? `${i.qty}x ` : ''}${this.escapar(i.nome)}`)
      .join('<br>');
    const resto = itens.length - 8;
    return (
      `<br><br><strong>${titulo}:</strong><br>${linhas}` +
      (resto > 0 ? `<br>• … e mais ${resto} peça(s)` : '')
    );
  }

  /** Link de acompanhamento — Correios tem página pública; outras, só o código. */
  private linkRastreio(codigo?: string | null, carrier?: string | null): string | null {
    if (!codigo) return null;
    const c = String(carrier || 'correios').toLowerCase();
    if (c.includes('correio') || c.includes('pac') || c.includes('sedex')) {
      return `https://rastreamento.correios.com.br/app/index.php?objeto=${encodeURIComponent(codigo)}`;
    }
    return null;
  }

  private moeda(v?: number | null): string {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  private escapar(v: any): string {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** O primeiro nome, que é como a loja fala com a cliente. */
  private primeiroNome(nome?: string | null): string {
    const n = String(nome || '').trim().split(/\s+/)[0];
    return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : 'Oi';
  }

  private itensDoPedido(order: any): ItemDoEmail[] {
    const itens: any[] = Array.isArray(order?.items) ? order.items : [];
    return itens.map((i) => ({
      nome: String(i?.productName || i?.sku || 'Peça'),
      quantidade: Number(i?.quantity) || 1,
      valor: i?.unitPrice ?? null,
    }));
  }

  /**
   * Layout em TABELA e estilo INLINE de propósito: cliente de e-mail (Gmail,
   * Outlook, app nativo) descarta `<style>` e não entende flex nem grid. O que
   * parece retrógrado aqui é o que chega inteiro na caixa de entrada.
   */
  private montarHtml(titulo: string, chamada: string, order: any, rodape: string): string {
    const itens = this.itensDoPedido(order);
    const linhas = itens
      .map(
        (i) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee;color:#333;font-size:14px">
            ${this.escapar(i.nome)}${i.quantidade > 1 ? ` <span style="color:#888">× ${i.quantidade}</span>` : ''}
          </td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#333;font-size:14px;white-space:nowrap">
            ${this.moeda(i.valor)}
          </td>
        </tr>`,
      )
      .join('');

    const numero = this.escapar(order?.wcOrderNumber || order?.id || '');

    return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:24px;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:8px">
    <tr><td style="padding:28px 28px 8px">
      <p style="margin:0;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#b8912b">Lurd's Plus Size</p>
      <h1 style="margin:12px 0 0;font-size:22px;color:#1a1a1a;font-weight:600">${this.escapar(titulo)}</h1>
      <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#444">${chamada}</p>
    </td></tr>

    <tr><td style="padding:20px 28px 0">
      <p style="margin:0 0 4px;font-size:13px;color:#888">Pedido</p>
      <p style="margin:0;font-size:16px;color:#1a1a1a;font-weight:600">${numero}</p>
    </td></tr>

    <tr><td style="padding:16px 28px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${linhas || '<tr><td style="color:#888;font-size:14px">—</td></tr>'}
        <tr>
          <td style="padding:12px 0 0;font-size:15px;color:#1a1a1a;font-weight:600">Total</td>
          <td style="padding:12px 0 0;text-align:right;font-size:15px;color:#1a1a1a;font-weight:600">${this.moeda(order?.totalAmount)}</td>
        </tr>
      </table>
    </td></tr>

    <tr><td style="padding:24px 28px 28px">
      <p style="margin:0;font-size:13px;line-height:1.7;color:#666">${rodape}</p>
      <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#999">
        Lurd's Plus Size · CNPJ 20.104.813/0001-39 · 14 lojas em São Paulo e região<br>
        Precisa de ajuda? Responda este e-mail ou fale com uma consultora no WhatsApp.
      </p>
    </td></tr>
  </table>
</body></html>`;
  }

  /** Versão texto — filtro de spam pune e-mail só-HTML, e alguns leem assim. */
  private montarTexto(titulo: string, order: any): string {
    const itens = this.itensDoPedido(order)
      .map((i) => `- ${i.nome}${i.quantidade > 1 ? ` x${i.quantidade}` : ''} ${this.moeda(i.valor)}`)
      .join('\n');
    return [
      titulo,
      '',
      `Pedido ${order?.wcOrderNumber || order?.id || ''}`,
      itens,
      `Total: ${this.moeda(order?.totalAmount)}`,
      '',
      "Lurd's Plus Size · CNPJ 20.104.813/0001-39",
    ].join('\n');
  }

  private destinatario(order: any): string | null {
    const e = String(order?.customerEmail || '').trim();
    return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(e) ? e : null;
  }

  /** Pedido criado — o dinheiro ainda não entrou (PIX aguardando, por ex.). */
  async aoCriarPedido(order: any): Promise<void> {
    void this.avisarN8n('pedido_criado', order);
    if (!this.emailProprioLigado) return;

    const para = this.destinatario(order);
    if (!para) {
      this.logger.warn(`[pedido-email] pedido ${order?.wcOrderNumber ?? order?.id} sem e-mail válido`);
      return;
    }
    const nome = this.primeiroNome(order?.customerName);
    const pix = String(order?.paymentInfo || '').includes('"pix"');
    const titulo = 'Recebemos seu pedido';
    const chamada = pix
      ? `${nome}, seu pedido está reservado e esperando o pagamento do Pix. Assim que ele cair, a gente confirma por aqui e começa a separar as peças.`
      : `${nome}, recebemos seu pedido. Assim que o pagamento for confirmado, avisamos por aqui e começamos a separar as peças.`;
    const rodape = `Se o pagamento não for concluído, o pedido é liberado automaticamente e as peças voltam pro estoque. Nada é cobrado.`;

    await this.enviar(para, `${titulo} · ${order?.wcOrderNumber ?? ''}`.trim(), titulo, chamada, order, rodape, 'pedido_criado');
  }

  /**
   * PIX gerado e não pago há 30min — o resgate mais barato do e-commerce:
   * ela preencheu TUDO (nome, telefone, endereço) e só falta pagar. Dois
   * canais no MESMO toque: WhatsApp via n8n (ramo `evento === 'pix_nao_pago'`)
   * e o e-mail próprio — os dois com o copia-e-cola, pra pagar sem reabrir
   * o site.
   *
   * Devolve se ALGUM canal saiu: o cron carimba `pixResgateAvisadoEm` e o
   * toque é um só — se um canal falhou mas o outro entregou, tocou. Só o
   * fracasso duplo tenta de novo no ciclo seguinte, dentro da janela.
   */
  async aoPixNaoPago(order: any): Promise<boolean> {
    const n8nOk = await this.avisarN8n('pix_nao_pago', order);
    const whatsOk = await this.avisarWhatsDireto('pix_nao_pago', order);

    let emailOk = false;
    const para = this.emailProprioLigado ? this.destinatario(order) : null;
    if (para) {
      const nome = this.primeiroNome(order?.customerName);
      const pix = this.pixDoPedido(order);
      // Com o PIX de 24h (17/08), "vale por mais 1380 minutos" não é frase.
      const validade = (() => {
        const m = pix.minutosRestantes;
        if (m === null || m <= 0) return '';
        if (m >= 120) return ` Ele vale por mais ${Math.floor(m / 60)} horas.`;
        return ` Ele vale por mais ${m} minutos.`;
      })();
      const titulo = 'Seu Pix está esperando';
      // NÃO diz "reservadas": desde 17/08 pedido não pago NÃO segura peça
      // (HORAS_PENDENTE = 0, decisão do dono). Prometer reserva e a peça
      // sair pra outra cliente é pior que não prometer.
      const chamada =
        `${nome}, o Pix do seu pedido ainda não caiu.${validade} ` +
        `É só copiar o código abaixo e colar na opção "Pix copia e cola" do app do seu banco:` +
        (pix.copiaECola
          ? `<div style="margin:14px 0 0;padding:12px;background:#f6f4ef;border:1px solid #e5e0d5;border-radius:6px;font-family:monospace;font-size:12px;word-break:break-all;color:#333">${this.escapar(pix.copiaECola)}</div>`
          : '');
      const rodape =
        'Se o Pix vencer, o pedido é cancelado automaticamente — nada é cobrado. ' +
        'Qualquer dúvida, responda este e-mail ou chame uma consultora no WhatsApp.';
      emailOk = await this.enviar(
        para,
        `${titulo} · pedido ${order?.wcOrderNumber ?? ''}`.trim(),
        titulo, chamada, order, rodape, 'pix_nao_pago',
      );
    }
    return n8nOk || whatsOk || emailOk;
  }

  /**
   * Pedido saiu pra entrega — o e-mail prometido no "Pagamento confirmado"
   * ("mandamos o código de rastreio") que até 14/08 ninguém cumpria: o
   * WhatsApp de rastreio só existia pra cliente da LIVE (ManyChat), e o
   * pedido do site novo não passa pelo WooCommerce que avisava o site velho.
   *
   * Chamado pelo afterShipped do pick-orders com guard atômico no pedido
   * (`rastreioAvisadoEm`) — pedido dividido despacha por loja e só o
   * PRIMEIRO pacote com rastreio gera o aviso.
   */
  async aoEnviarPedido(order: any, caixa?: CaixaAviso | null): Promise<void> {
    void this.avisarN8n('pedido_enviado', order, caixa);
    void this.avisarWhatsDireto('pedido_enviado', order, caixa);
    if (!this.emailProprioLigado) return;

    const para = this.destinatario(order);
    if (!para) {
      this.logger.warn(`[pedido-email] pedido ${order?.wcOrderNumber ?? order?.id} enviado, mas sem e-mail válido`);
      return;
    }
    const nome = this.primeiroNome(order?.customerName);
    const codigo = String(order?.trackingCode || '').trim();
    const transportadora = this.transportadoraParaCliente(order?.carrier);
    const link = this.linkRastreio(codigo, String(order?.carrier || 'Correios'));
    const fracionado = (caixa?.total ?? 1) > 1;
    const titulo = fracionado
      ? `Caixa ${caixa!.posicao} de ${caixa!.total} do seu pedido saiu pra entrega`
      : 'Seu pedido saiu pra entrega';
    const chamada =
      (fracionado
        ? `${nome}, suas peças vêm em ${caixa!.total} caixas — esta é a caixa ` +
          `<strong>${caixa!.posicao} de ${caixa!.total}</strong>, já com a ${this.escapar(transportadora)}. ` +
          `Cada caixa tem o próprio código de rastreio, e você recebe um aviso como este pra cada uma.`
        : `${nome}, suas peças já estão com a ${this.escapar(transportadora)}.`) +
      (codigo
        ? ` Acompanhe a entrega com o código <strong style="font-family:monospace">${this.escapar(codigo)}</strong>` +
          (link ? ` — ou <a href="${link}" style="color:#b8912b">clique aqui pra rastrear</a>.` : '.')
        : '') +
      this.blocoItensCaixaHtml(caixa);
    const rodape =
      `Não serviu? Você tem ${PedidoEmailService.DIAS_TROCA} dias corridos a partir do recebimento pra trocar ` +
      `pelo portal de trocas ou em qualquer uma das nossas lojas.`;

    await this.enviar(para, `${titulo} · pedido ${order?.wcOrderNumber ?? ''}`.trim(), titulo, chamada, order, rodape, 'pedido_enviado');
  }

  /**
   * A MENSAGEM DA VENDA ONLINE DO PDV — registra o pedido, não afirma pagamento.
   *
   * Nasceu em 20/08 (caso ON-000049) só pro pedido SEM prova de gateway: "PIX
   * recebido" e "Link externo" fecham no braço, o sistema não sabe se o
   * dinheiro entrou, e a Claudia recebeu "recebemos o seu pagamento" às 17:26
   * e respondeu "Nao paguei ainda" às 17:27.
   *
   * Desde 31/08 (ordem do dono) vale pra TODA venda online da vendedora, com
   * prova ou sem: a confirmação de pagamento automática saiu do trilho do
   * `pdv_online` inteiro — quem confirma o dinheiro é a vendedora, no
   * atendimento que ela já está tendo. Ver `aoConfirmarPagamento`.
   *
   * O que esta mensagem faz continua igual e é o motivo de ela existir desde
   * 14/08: manda o número do pedido e as peças pra cliente conferir.
   *
   * ⚠️ NUNCA sai pelo n8n: o `avisarN8n` manda `order.status`, que no pedido
   * do PDV é 'processing' — exatamente o gatilho do IF do fluxo "Pedido
   * Pago". Qualquer evento pro webhook com esse status vira "recebemos o seu
   * pagamento" no WhatsApp da cliente. Por isso o canal é o WhatsApp direto
   * (mesmo kill-switch `WHATS_PEDIDO_DIRETO`).
   */
  async aoRegistrarPedidoOnline(order: any): Promise<void> {
    if (!this.whatsDiretoLigado) return;
    const telefone = String(order?.customerPhone || '').replace(/\D/g, '');
    if (telefone.length < 10) return;

    const nome = this.primeiroNome(order?.customerName);
    const numero = order?.wcOrderNumber ? ` ${order.wcOrderNumber}` : '';
    // Lista das peças PRA CONFERÊNCIA (pedido do dono, 20/08): a cliente
    // confere na hora se a vendedora registrou o que ela pediu — REF, cor e
    // tamanho errados aparecem AQUI, antes de a peça viajar.
    const linhas = (Array.isArray(order?.items) ? order.items : [])
      .map((i: any) => {
        const desc = [i?.ref || i?.productName, i?.cor, i?.tamanho]
          .filter(Boolean)
          .join(' · ');
        const qtd = Number(i?.quantity) || 1;
        return `• ${desc || i?.sku || 'Peça'}${qtd > 1 ? ` ×${qtd}` : ''} — ${this.moeda(i?.unitPrice)}`;
      })
      .join('\n');
    const texto =
      `Oi, ${nome}! 💛\n\nSeu pedido${numero} foi registrado com a nossa equipe:\n\n` +
      (linhas ? `${linhas}\n\n` : '') +
      `Total: ${this.moeda(order?.totalAmount)}\n\n` +
      `Confere se está tudo certinho? Qualquer coisa é só responder por aqui — ` +
      `e assim que o pedido sair, mandamos o código de rastreio.`;

    try {
      const r = await this.whats.sendText(telefone, texto);
      if (!r?.ok) {
        this.logger.warn(
          `[pedido-whats] registro do pedido online não saiu (pedido ${order?.wcOrderNumber}): ${r?.error}`,
        );
      }
      this.registrar('pedido_online_registro', 'whatsapp', order, !!r?.ok, telefone, r?.ok ? null : r?.error);
    } catch (e: any) {
      this.logger.warn(
        `[pedido-whats] registro do pedido online falhou (pedido ${order?.wcOrderNumber}): ${e?.message || e}`,
      );
      this.registrar('pedido_online_registro', 'whatsapp', order, false, telefone, e?.message || String(e));
    }
  }

  /** Pagamento confirmado — a mensagem que a cliente realmente espera. */
  async aoConfirmarPagamento(order: any): Promise<void> {
    /**
     * VENDA ONLINE DA VENDEDORA NÃO CONFIRMA PAGAMENTO SOZINHA (31/08 — dono).
     *
     * No pedido `pdv_online` quem recebeu o dinheiro foi a vendedora, dentro de
     * uma conversa que ela já está tendo com a cliente no WhatsApp da loja. O
     * "recebemos o seu pagamento" automático chega DEPOIS dela, por outro
     * número, dizendo o que a cliente já sabe — e quando o sistema erra a
     * leitura, erra na frente de quem estava atendendo (caso ON-000049, 19/08:
     * confirmação às 17:26, "Nao paguei ainda" às 17:27).
     *
     * O pedido do SITE não muda em nada: lá não existe vendedora do outro lado,
     * e a confirmação automática é a única coisa que a cliente recebe.
     *
     * A trava mora AQUI, e não só em quem chama, porque este método é a porta
     * dos dois canais (n8n → WhatsApp e e-mail próprio): quem escrever o
     * terceiro caminho amanhã não precisa lembrar da regra.
     *
     * A venda online não fica muda — ela manda `aoRegistrarPedidoOnline`, que
     * registra número e peças SEM afirmar pagamento.
     */
    if (String(order?.source ?? '').trim() === 'pdv_online') {
      this.logger.log(
        `[pedido-msg] pedido ${order?.wcOrderNumber ?? order?.id}: confirmação automática de ` +
          `pagamento RETIDA — venda online lançada pela vendedora (ela confirma no atendimento).`,
      );
      // Fica no registro: "por que a cliente não recebeu a confirmação?" tem
      // que ter resposta também quando a resposta é "porque a regra manda".
      // Silêncio combinado e silêncio por defeito são idênticos de fora.
      this.registrar(
        'pagamento_confirmado', 'regra', order, false, null,
        'retido: venda online da vendedora (a vendedora confirma no atendimento)',
      );
      return;
    }

    void this.avisarN8n('pagamento_confirmado', order);
    if (!this.emailProprioLigado) return;

    const para = this.destinatario(order);
    if (!para) {
      this.logger.warn(`[pedido-email] pedido ${order?.wcOrderNumber ?? order?.id} pago, mas sem e-mail válido`);
      return;
    }
    const nome = this.primeiroNome(order?.customerName);
    const titulo = 'Pagamento confirmado';
    const chamada = `${nome}, seu pagamento entrou e o pedido já está com a nossa equipe pra separação. Quando ele sair pra entrega, mandamos o código de rastreio.`;
    const rodape =
      `Não serviu? Você tem ${PedidoEmailService.DIAS_TROCA} dias corridos a partir do recebimento pra trocar ` +
      `pelo portal de trocas ou em qualquer uma das nossas lojas.`;

    await this.enviar(para, `${titulo} · pedido ${order?.wcOrderNumber ?? ''}`.trim(), titulo, chamada, order, rodape, 'pagamento_confirmado');
  }

  /**
   * ENTREGA CONFIRMADA — o fim do ciclo, que até 14/08 acontecia em silêncio.
   *
   * O sistema já sabia da entrega (`TrackingService.delivered`) e não dizia
   * nada justo no momento mais útil: a peça está na mão da cliente e é AGORA
   * que o prazo de troca começa a correr. Dizer a data em que ele vence evita
   * a conversa mais cara do pós-venda ("mas eu achei que tinha mais tempo").
   *
   * É também o único momento em que pedir avaliação faz sentido — ela acabou
   * de provar a roupa. Prova social real, das clientes que compraram de fato.
   */
  async aoEntregar(order: any): Promise<boolean> {
    const n8nOk = await this.avisarN8n('pedido_entregue', order);
    const whatsOk = await this.avisarWhatsDireto('pedido_entregue', order);
    if (!this.emailProprioLigado) return n8nOk || whatsOk;

    const para = this.destinatario(order);
    if (!para) return n8nOk || whatsOk;

    const nome = this.primeiroNome(order?.customerName);
    const limite = new Date(Date.now() + PedidoEmailService.DIAS_TROCA * 24 * 60 * 60 * 1000);
    const ateQuando = limite.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const titulo = 'Seu pedido chegou';
    const chamada =
      `${nome}, os Correios confirmaram a entrega do seu pedido. Esperamos que sirva certinho e que você ame as peças!` +
      `<br><br>Se alguma coisa não ficou como você esperava, dá pra trocar até <strong>${ateQuando}</strong> ` +
      `— pelo portal de trocas ou em qualquer uma das nossas ${PedidoEmailService.LOJAS_NA_REDE} lojas, sem complicação.`;
    const rodape =
      'Ficou boa em você? Responde esse e-mail com uma foto ou um "amei" — a gente adora ver, ' +
      'e sua opinião ajuda outra cliente a escolher o tamanho certo.';

    const emailOk = await this.enviar(
      para, `${titulo} · pedido ${order?.wcOrderNumber ?? ''}`.trim(), titulo, chamada, order, rodape, 'pedido_entregue',
    );
    return n8nOk || whatsOk || emailOk;
  }

  /** Devolve se o e-mail SAIU — o resgate do PIX usa isso pra decidir o carimbo. */
  private async enviar(
    para: string, assunto: string, titulo: string, chamada: string, order: any, rodape: string,
    /** Qual aviso é este — só pro registro em `avisos_enviados`. */
    evento = 'email',
  ): Promise<boolean> {
    try {
      const ok = await this.email.send(
        para,
        assunto,
        this.montarHtml(titulo, chamada, order, rodape),
        this.montarTexto(titulo, order),
      );
      this.registrar(
        evento, 'email', order, !!ok, para,
        ok ? null : 'email.send devolveu falso (SMTP configurado?)',
      );
      if (ok) {
        this.logger.log(`[pedido-email] "${titulo}" enviado pro pedido ${order?.wcOrderNumber ?? order?.id}`);
      } else {
        // Distingue "não configuramos" de "falhou": sem isto, a ausência de
        // e-mail vira mistério na primeira reclamação.
        this.logger.warn(
          `[pedido-email] "${titulo}" NÃO enviado (pedido ${order?.wcOrderNumber ?? order?.id}) — ` +
            `SMTP_HOST/USER/PASS configurados?`,
        );
      }
      return !!ok;
    } catch (e: any) {
      this.logger.warn(`[pedido-email] falhou: ${e?.message || e}`);
      this.registrar(evento, 'email', order, false, para, e?.message || String(e));
      return false;
    }
  }
}
