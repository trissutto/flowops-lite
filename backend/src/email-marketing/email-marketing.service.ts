import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MauticClient } from './mautic.client';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CAMPANHA DE E-MAIL PELO FLOWOPS (dono, 14/08/2026).
 *
 * A operadora escolhe um segmento do Mautic, escreve assunto e texto e dispara
 * — sem abrir o Mautic. Este service é a regra de negócio no meio:
 *
 *   · monta o HTML no padrão da marca a partir do texto simples (a operadora
 *     não escreve HTML);
 *   · a PRÉVIA vai pelo NOSSO e-mail (EmailService/SES) pra um endereço de
 *     teste — valida como a peça CHEGA, sem sujar o Mautic com e-mail de teste;
 *   · o ENVIO REAL cria o e-mail-lista no Mautic e dispara pro segmento, que é
 *     quem tem a base, a entregabilidade e o descadastro.
 */
@Injectable()
export class EmailMarketingService {
  private readonly logger = new Logger(EmailMarketingService.name);

  constructor(
    private readonly mautic: MauticClient,
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * RESULTADO DA CAMPANHA — pedidos que vieram do e-mail, contados NO NOSSO
   * BANCO. Não passa pelo Mautic de propósito: em 14/08 o painel dele marcou
   * zero abertura e zero clique em 13.014 envios que comprovadamente chegaram.
   * Aqui a conta é o pedido, que ou existe ou não existe.
   *
   * `De/Até` opcionais; sem eles, os últimos 30 dias.
   */
  async resultados(de?: string | null, ate?: string | null) {
    const fim = ate ? new Date(`${ate}T23:59:59`) : new Date();
    const inicio = de ? new Date(`${de}T00:00:00`) : new Date(fim.getTime() - 30 * 24 * 3600 * 1000);

    const pedidos = await this.prisma.order.findMany({
      where: { utmSource: 'email', wcDateCreated: { gte: inicio, lte: fim } },
      select: { utmCampaign: true, totalAmount: true, status: true, wcDateCreated: true },
    });

    const porCampanha = new Map<string, { campanha: string; pedidos: number; receita: number; pagos: number }>();
    for (const p of pedidos) {
      const k = p.utmCampaign || '(sem nome)';
      const atual = porCampanha.get(k) ?? { campanha: k, pedidos: 0, receita: 0, pagos: 0 };
      atual.pedidos++;
      // Só soma dinheiro de pedido que virou venda — pendente/cancelado infla o número.
      const pago = !['cancelled', 'failed', 'pending', 'payment_failed'].includes(String(p.status));
      if (pago) { atual.pagos++; atual.receita += Number(p.totalAmount ?? 0); }
      porCampanha.set(k, atual);
    }

    return {
      de: inicio.toISOString().slice(0, 10),
      ate: fim.toISOString().slice(0, 10),
      campanhas: [...porCampanha.values()].sort((a, b) => b.receita - a.receita),
      totalPedidos: pedidos.length,
      totalReceita: [...porCampanha.values()].reduce((s, c) => s + c.receita, 0),
    };
  }

  async status() {
    if (!this.mautic.configurado()) {
      return { ok: false, configurado: false, erro: 'Mautic ainda não conectado (faltam MAUTIC_BASE/USER/PASS + API habilitada).' };
    }
    const s = await this.mautic.status();
    return { ok: s.ok, configurado: true, erro: s.erro };
  }

  async segmentos() {
    const lista = await this.mautic.segmentos();
    // Maior primeiro — a operadora quase sempre quer o público grande no topo.
    return lista.sort((a, b) => (b.contatos ?? 0) - (a.contatos ?? 0));
  }

  /**
   * TEXTO SIMPLES → HTML da marca. A operadora escreve como escreveria no
   * WhatsApp; a gente veste. Cada linha em branco separa parágrafo; `**x**`
   * vira negrito; uma linha só com um link vira botão.
   */
  /** Link seguro: só http(s), senão vira o site (nunca deixa `javascript:` passar). */
  private linkSeguro(url?: string | null): string {
    const u = String(url || '').trim();
    return /^https?:\/\//i.test(u) ? u : 'https://www.lurdsplussize.com.br';
  }

  /**
   * NOME DA CAMPANHA PRO RASTREIO — sai do assunto, sem a operadora digitar nada.
   * Vira o `utm_campaign`, que é o que aparece no relatório de pedidos.
   */
  private slugCampanha(assunto: string, agora = new Date()): string {
    const base = assunto
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '');
    const dia = String(agora.getDate()).padStart(2, '0');
    const mes = String(agora.getMonth() + 1).padStart(2, '0');
    return `${base || 'campanha'}-${dia}${mes}`;
  }

  /**
   * CARIMBA A UTM NO LINK — é isto que responde "o e-mail deu venda?".
   *
   * Medição de 15/08/2026: as 4 campanhas de 14/08 somaram 13.014 envios com
   * ZERO abertura e ZERO clique no painel do Mautic — sendo que o dono abriu o
   * e-mail e houve acesso no link. O rastreio do Mautic não pegou nada (o HTML
   * saiu pela API sem os tokens dele). Ou seja: **não dá pra depender do Mautic
   * pra saber se a campanha vendeu.** A UTM resolve isso do nosso lado — o site
   * já lê `utm_*` da URL e o pedido já grava `utmSource/utmCampaign` (Order),
   * então o pedido nasce sabendo de qual campanha veio, medido em casa.
   *
   * UTM que a operadora já tenha colado à mão é respeitada — não sobrescreve.
   */
  private comUtm(url: string, campanha: string, temArte: boolean): string {
    try {
      const u = new URL(url);
      if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', 'email');
      if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', 'email');
      if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', campanha);
      if (temArte && !u.searchParams.has('utm_content')) u.searchParams.set('utm_content', 'arte');
      return u.toString();
    } catch {
      // URL impossível de parsear não vira link quebrado — devolve como veio.
      return url;
    }
  }

  /**
   * `:yellow_heart:` é atalho de Slack, não emoji — e saiu CRU no assunto das 4
   * campanhas de 14/08 ("Inauguração do site novo :yellow_heart:"), do jeito que
   * a cliente leu. Converte os conhecidos e apaga o resto.
   */
  private limparAssunto(assunto: string): string {
    const mapa: Record<string, string> = {
      yellow_heart: '💛', heart: '❤️', blue_heart: '💙', green_heart: '💚',
      purple_heart: '💜', black_heart: '🖤', white_heart: '🤍', orange_heart: '🧡',
      brown_heart: '🤎', sparkles: '✨', fire: '🔥', tada: '🎉', star: '⭐',
      eyes: '👀', gift: '🎁', dress: '👗', jeans: '👖', shopping_bags: '🛍️',
      alarm_clock: '⏰', bell: '🔔', rocket: '🚀', smile: '😊', sunglasses: '😎',
      warning: '⚠️', point_right: '👉', white_check_mark: '✅', pray: '🙏',
    };
    return String(assunto)
      .replace(/:([a-z0-9_+-]+):/gi, (_todo, nome: string) => mapa[String(nome).toLowerCase()] ?? '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * VERSÃO TEXTO do e-mail. Não é enfeite: e-mail só-HTML pontua como spam, e
   * as campanhas de julho (que abriram 3,8%) tinham texto — as nossas saíram
   * com zero byte. Também é o que a cliente lê no relógio e no leitor de tela.
   */
  private montarTexto(assunto: string, corpo: string, cupom: string | null | undefined, destino: string): string {
    const limpo = corpo.replace(/\*\*(.+?)\*\*/g, '$1').trim();
    return [
      this.limparAssunto(assunto),
      '',
      limpo,
      cupom ? `\nCupom: ${cupom}` : '',
      '',
      `Comprar agora: ${destino}`,
      '',
      '—',
      'Lurd\'s Plus Size · moda plus size do 46 ao 60 · 14 lojas físicas.',
      'Para não receber mais estes e-mails: {unsubscribe_url}',
    ].filter((l) => l !== null).join('\n');
  }

  private montarHtml(
    assunto: string,
    corpo: string,
    cupom?: string | null,
    imagemUrl?: string | null,
    linkDestino?: string | null,
    opcoes?: { previa?: boolean; campanha?: string },
  ): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const img = String(imagemUrl || '').trim();
    const temArte = /^https?:\/\//i.test(img);
    const campanha = opcoes?.campanha ?? this.slugCampanha(assunto);
    const destino = this.comUtm(this.linkSeguro(linkDestino), campanha, temArte);
    /**
     * `{unsubscribe_url}` é token do Mautic — só existe no envio real. Na prévia
     * (que sai pelo nosso SES) ele apareceria cru pra operadora, então vira '#'.
     */
    const descadastro = opcoes?.previa ? '#' : '{unsubscribe_url}';

    /**
     * A ARTE VAI NO TOPO e é CLICÁVEL — o clique cai direto na peça (dono,
     * 14/08): e-mail de lançamento sem imagem não converte, e mandar pra home
     * faz a cliente procurar de novo o que o anúncio já mostrou. `img` só entra
     * se for http(s); a borda arredondada casa com o cartão.
     */
    const hero = temArte
      ? `<tr><td style="padding:0"><a href="${destino}"><img src="${img}" alt="${esc(assunto)}" style="display:block;width:100%;max-width:560px;border-radius:10px 10px 0 0" /></a></td></tr>`
      : '';

    const paras = corpo
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const comBold = esc(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
        return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3a3630">${comBold}</p>`;
      })
      .join('');

    const blocoCupom = cupom
      ? `<p style="font-size:22px;font-weight:bold;background:#FBF6E6;border:2px dashed #B8912B;border-radius:12px;padding:14px;text-align:center;letter-spacing:2px;color:#8C7325;margin:0 0 20px">${esc(cupom)}</p>`
      : '';

    return `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:10px">
    ${hero}
    <tr><td style="padding:28px 28px 8px">
      <p style="margin:0;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#b8912b">Lurd's Plus Size</p>
      <h1 style="margin:12px 0 18px;font-size:22px;color:#1a1a1a;font-weight:600">${esc(this.limparAssunto(assunto))}</h1>
    </td></tr>
    <tr><td style="padding:0 28px 8px">${paras}${blocoCupom}</td></tr>
    <tr><td style="padding:8px 28px 28px">
      <a href="${destino}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:600">Comprar agora</a>
    </td></tr>
    <tr><td style="padding:16px 28px 28px;border-top:1px solid #eee">
      <p style="margin:0;font-size:12px;color:#999">Moda plus size do 46 ao 60 · 14 lojas físicas · troca fácil.<br>
      Você recebe porque se cadastrou na Lurd's.</p>
      <p style="margin:10px 0 0;font-size:12px;color:#999">
        <a href="${descadastro}" style="color:#777;text-decoration:underline">Não quero mais receber estes e-mails</a>
      </p>
    </td></tr>
  </table>
</body></html>`;
  }

  private validar(assunto: string, corpo: string) {
    if (String(assunto).trim().length < 3) throw new BadRequestException('Escreva um assunto (mín. 3 letras).');
    if (String(corpo).trim().length < 10) throw new BadRequestException('Escreva o texto do e-mail (mín. 10 letras).');
  }

  /** Prévia no e-mail de teste — pelo NOSSO SES, sem tocar no Mautic. */
  async enviarPrevia(input: { destino: string; assunto: string; corpo: string; cupom?: string | null; imagemUrl?: string | null; linkDestino?: string | null }) {
    this.validar(input.assunto, input.corpo);
    const destino = String(input.destino || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(destino)) throw new BadRequestException('E-mail de teste inválido.');
    const assunto = this.limparAssunto(input.assunto);
    const campanha = this.slugCampanha(assunto);
    const html = this.montarHtml(assunto, input.corpo, input.cupom, input.imagemUrl, input.linkDestino, {
      previa: true,
      campanha,
    });
    const texto = this.montarTexto(assunto, input.corpo, input.cupom, this.comUtm(this.linkSeguro(input.linkDestino), campanha, false));
    const ok = await this.email.send(destino, `[PRÉVIA] ${assunto}`, html, texto);
    if (!ok) throw new BadRequestException('Não conseguimos enviar a prévia — confira o SMTP/SES do backend.');
    return { ok: true, destino, campanha };
  }

  /**
   * ENVIO REAL: cria o e-mail-lista no Mautic e dispara pro segmento.
   * `agendarPara` (ISO) opcional — o Mautic só parte a partir dela.
   */
  async enviarCampanha(input: {
    segmentoId: number;
    assunto: string;
    corpo: string;
    cupom?: string | null;
    agendarPara?: string | null;
    imagemUrl?: string | null;
    linkDestino?: string | null;
  }) {
    this.validar(input.assunto, input.corpo);
    if (!Number.isFinite(input.segmentoId) || input.segmentoId <= 0) {
      throw new BadRequestException('Escolha o público (segmento) do disparo.');
    }
    const assunto = this.limparAssunto(input.assunto);
    const campanha = this.slugCampanha(assunto);
    const destino = this.comUtm(this.linkSeguro(input.linkDestino), campanha, false);
    const html = this.montarHtml(assunto, input.corpo, input.cupom, input.imagemUrl, input.linkDestino, { campanha });
    const texto = this.montarTexto(assunto, input.corpo, input.cupom, destino);
    const nome = `[FlowOps] ${assunto}`.slice(0, 120);

    const email = await this.mautic.criarEmailLista({
      nome,
      assunto,
      html,
      texto,
      segmentoId: input.segmentoId,
      publishUp: input.agendarPara ?? null,
    });

    // Agendado: NÃO dispara agora — o Mautic parte na data. Disparar aqui
    // furaria o agendamento e mandaria na hora.
    if (input.agendarPara) {
      this.logger.log(`[campanha] agendada #${email.id} → segmento ${input.segmentoId} pra ${input.agendarPara} · utm_campaign=${campanha}`);
      return { ok: true, emailId: email.id, agendado: true, para: input.agendarPara, campanha };
    }

    const envio = await this.mautic.enviarParaSegmento(email.id);
    this.logger.log(`[campanha] enviada #${email.id} → segmento ${input.segmentoId} · enfileirados ${envio.enfileirados ?? '?'} · utm_campaign=${campanha}`);
    return { ok: envio.sucesso, emailId: email.id, agendado: false, enfileirados: envio.enfileirados, campanha };
  }
}
