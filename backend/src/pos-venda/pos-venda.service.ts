import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { CloudflareImagesClient } from '../site-media/cloudflare-images.client';
import { refBaseOf } from '../common/ref-base';
import { PontosService } from './pontos.service';

/**
 * PÓS-VENDA — pedir a opinião de quem já recebeu, e pagar por ela.
 *
 * ── O BURACO QUE ISTO FECHA ──
 *
 * O ciclo do pedido acabava na entrega. A cliente ficava com a peça, sabia se
 * serviu, se a cor era a da foto e se o tecido era o que ela imaginou — e nada
 * disso era perguntado. Enquanto isso a PDP mostrava um espaço vazio onde
 * ficavam os depoimentos falsos que saíram do ar em 06/08 ("Cliente Lurds",
 * altura e peso inventados, as mesmas quatro frases em toda peça).
 *
 * ── AS REGRAS QUE MORAM AQUI ──
 *
 * 1. **D+5 da ENTREGA, não do envio.** Antes disso ela ainda não usou. O marco
 *    é o `deliveredAt`, que o `RastreioSyncCron` carimba quando a
 *    transportadora confirma — a mesma fonte do aviso "seu pedido chegou".
 *
 * 2. **Uma avaliação por PEÇA.** O pedido tem três peças; ela ama uma e devolve
 *    outra. Nota por pedido não serve pra PDP nenhuma.
 *
 * 3. **A FOTO dobra os pontos — a NOTA não muda nada** (decisão do dono,
 *    19/08). Pagar mais por 5★ é comprar avaliação: enviesa a média e, quando a
 *    cliente percebe que só existe 5★, ela para de acreditar no bloco inteiro —
 *    que é exatamente o que aconteceu com os depoimentos falsos. A foto é o
 *    conteúdo que vende; o bônus vai pra ela.
 *
 * 4. **Nada aparece no site sem aprovação** (decisão do dono, 19/08). Foto de
 *    cliente vai direto pra página do produto.
 *
 * 5. **Ponto só é creditado na APROVAÇÃO.** Assim ninguém precisa estornar
 *    saldo já gasto quando uma avaliação é reprovada.
 *
 * Kill-switch: `POS_VENDA_AVALIACAO=0` (env) ou `ativo:false` na configuração
 * gravada no banco — o botão da tela precisa valer na hora, sem deploy.
 */

export interface PosVendaConfig {
  ativo: boolean;
  /** Dias após a ENTREGA confirmada até o convite sair. */
  diasAposEntrega: number;
  /** Entrega mais velha que isso não recebe convite — notícia velha. */
  janelaDias: number;
  pontosPorAvaliacao: number;
  /** Multiplicador quando vem foto (qualquer nota). */
  multiplicadorFoto: number;
  /** Quantos pontos valem R$ 1,00 no resgate. */
  pontosPorReal: number;
  minimoResgate: number;
  /** Validade do link do convite. */
  linkValidadeDias: number;
  /** Teto de reenvios manuais pela retaguarda. */
  maxReenvios: number;
}

const PADRAO: PosVendaConfig = {
  ativo: true,
  diasAposEntrega: 5,
  janelaDias: 30,
  pontosPorAvaliacao: 20,
  multiplicadorFoto: 2,
  pontosPorReal: 10,
  minimoResgate: 100,
  linkValidadeDias: 45,
  maxReenvios: 2,
};

/**
 * Origens que entram no pós-venda.
 *
 * O site ANTIGO (`source: 'site'`, WooCommerce) fica de fora de propósito: o
 * pedido de lá nasce de um espelho, e o item nem sempre tem REF/cor confiáveis
 * — a avaliação cairia na família errada, que é pior que não existir (a lição
 * da REF reciclada). Ele aparece em "Em trânsito", que só depende do rastreio,
 * e não aqui, que depende de saber QUAL peça a cliente recebeu.
 */
export const ORIGENS_POS_VENDA = ['ecommerce', 'pdv_online', 'live'];

@Injectable()
export class PosVendaService {
  private readonly logger = new Logger(PosVendaService.name);

  private static readonly CHAVE_CONFIG = 'pos_venda_config';
  /** Teto de fotos por convite — trava de abuso, não de generosidade. */
  private static readonly MAX_FOTOS = 12;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly whats: WhatsappService,
    private readonly cloudflare: CloudflareImagesClient,
    private readonly pontos: PontosService,
  ) {}

  // ─────────────────────────── configuração ───────────────────────────

  async lerConfig(): Promise<PosVendaConfig> {
    try {
      const s = await (this.prisma as any).systemSetting.findUnique({
        where: { key: PosVendaService.CHAVE_CONFIG },
      });
      const gravado = s?.value ? JSON.parse(s.value) : {};
      const cfg = { ...PADRAO, ...gravado };
      // Env é o freio de mão: derruba o programa inteiro sem depender de tela.
      if (String(process.env.POS_VENDA_AVALIACAO ?? '1').trim() === '0') cfg.ativo = false;
      return cfg;
    } catch {
      return { ...PADRAO };
    }
  }

  async salvarConfig(patch: Partial<PosVendaConfig>, quem?: string): Promise<PosVendaConfig> {
    const atual = await this.lerConfig();
    const novo: PosVendaConfig = { ...atual, ...patch };
    await (this.prisma as any).systemSetting.upsert({
      where: { key: PosVendaService.CHAVE_CONFIG },
      create: { key: PosVendaService.CHAVE_CONFIG, value: JSON.stringify(novo) },
      update: { value: JSON.stringify(novo) },
    });
    this.logger.log(`[pos-venda] configuração alterada por ${quem || 'sistema'}`);
    return novo;
  }

  // ─────────────────────────── o convite ───────────────────────────

  /** Endereço da vitrine — a mesma env que o revalidate usa. Aceita lista. */
  private baseDoSite(): string {
    const bruto = String(this.config.get<string>('ECOMMERCE_URL') || '').split(',')[0].trim();
    return (bruto || 'https://www.lurdsplussize.com.br').replace(/\/+$/, '');
  }

  linkDoConvite(token: string): string {
    return `${this.baseDoSite()}/avaliar/${token}`;
  }

  /**
   * Cria o convite do pedido (ou devolve o que já existe).
   *
   * `orderId` unique na tabela é a trava: dois processos (o cron reentrando
   * depois de um restart) não criam dois convites — e o link que já foi pro
   * WhatsApp continua valendo.
   */
  async criarConvite(orderId: string): Promise<any> {
    const cfg = await this.lerConfig();
    const pedido = await (this.prisma as any).order.findUnique({
      where: { id: orderId },
      select: {
        id: true, wcOrderNumber: true, customerName: true, customerPhone: true,
        customerCpf: true, personId: true, deliveredAt: true, avaliacaoConvite: true,
      },
    });
    if (!pedido) throw new NotFoundException('Pedido não encontrado');
    if (pedido.avaliacaoConvite) return pedido.avaliacaoConvite;

    return (this.prisma as any).avaliacaoConvite.create({
      data: {
        orderId: pedido.id,
        token: randomBytes(24).toString('base64url'),
        cpf: PontosService.cpfValido(pedido.customerCpf),
        telefone: PontosService.digits(pedido.customerPhone).slice(0, 20) || null,
        nomeCliente: pedido.customerName ?? null,
        entregueEm: pedido.deliveredAt ?? null,
        expiraEm: new Date(Date.now() + cfg.linkValidadeDias * 86_400_000),
      },
    });
  }

  /**
   * Manda o convite pela cliente. Dois canais, como todo aviso de pedido da
   * casa: o webhook do n8n (onde vivem os fluxos) e o WhatsApp direto (o plano
   * B liberado pelo dono em 14/08). Devolve se ALGUM canal saiu.
   *
   * Carimba `enviadoEm` só quando algo saiu de verdade — carimbo sem mensagem
   * é pior que retry: o pedido some do radar pra sempre.
   */
  async enviarConvite(conviteId: string, canal: 'whatsapp' | 'manual' = 'whatsapp'): Promise<boolean> {
    const cfg = await this.lerConfig();
    const convite = await (this.prisma as any).avaliacaoConvite.findUnique({
      where: { id: conviteId },
      include: { order: { select: { wcOrderNumber: true, customerName: true, customerPhone: true } } },
    });
    if (!convite) throw new NotFoundException('Convite não encontrado');

    const telefone = PontosService.digits(convite.telefone || convite.order?.customerPhone);
    const nome = String(convite.nomeCliente || convite.order?.customerName || '')
      .trim().split(/\s+/)[0] || 'tudo bem';
    const numero = convite.order?.wcOrderNumber ? ` ${convite.order.wcOrderNumber}` : '';
    const link = this.linkDoConvite(convite.token);
    const dobro = cfg.pontosPorAvaliacao * cfg.multiplicadorFoto;

    const texto =
      `Oi, ${nome}! 💛\n\nSeu pedido${numero} chegou faz alguns dias — conta pra gente como ficou?\n\n` +
      `Você ganha *${cfg.pontosPorAvaliacao} pontos* por peça avaliada e *${dobro}* se mandar uma foto ` +
      `usando. Os pontos viram desconto na próxima compra.\n\n` +
      `Leva menos de um minuto:\n${link}`;

    const n8nOk = await this.avisarN8n(convite, link, texto);
    let whatsOk = false;
    if (telefone.length >= 10) {
      try {
        const r = await this.whats.sendText(telefone, texto);
        whatsOk = !!r?.ok;
        if (!whatsOk) this.logger.warn(`[pos-venda] convite não saiu (${convite.id}): ${r?.error}`);
      } catch (e: any) {
        this.logger.warn(`[pos-venda] WhatsApp falhou (${convite.id}): ${e?.message || e}`);
      }
    }

    if (!n8nOk && !whatsOk) return false;
    await (this.prisma as any).avaliacaoConvite.update({
      where: { id: convite.id },
      data: { enviadoEm: new Date(), canal, tentativas: { increment: 1 } },
    });
    return true;
  }

  /**
   * O payload imita o dos outros avisos de pedido (`PedidoEmailService`): é o
   * formato que os fluxos do n8n já sabem ler. `evento` distingue o ramo.
   */
  private async avisarN8n(convite: any, link: string, texto: string): Promise<boolean> {
    const url = String(this.config.get<string>('N8N_PEDIDO_WEBHOOK_URL') || '').trim();
    if (!url) return false;
    const telefone = PontosService.digits(convite.telefone);
    const nomeCompleto = String(convite.nomeCliente || '').trim();
    const [primeiro, ...resto] = nomeCompleto.split(/\s+/);
    try {
      await firstValueFrom(
        this.http.post(
          url,
          {
            id: convite.order?.wcOrderNumber ?? convite.orderId,
            status: 'delivered',
            evento: 'avaliar_pedido',
            billing: {
              first_name: primeiro || '',
              last_name: resto.join(' '),
              phone: telefone,
            },
            avaliacao: { link, token: convite.token, texto },
          },
          { timeout: 8_000 },
        ),
      );
      return true;
    } catch (e: any) {
      this.logger.warn(`[pos-venda] n8n recusou o convite ${convite.id}: ${e?.message || e}`);
      return false;
    }
  }

  // ─────────────────────────── a página pública ───────────────────────────

  /**
   * O que a cliente vê ao abrir o link: as peças do pedido, o que ela já
   * avaliou e quanto vale cada resposta.
   *
   * Agrupa por REF-BASE + COR de propósito: quem comprou o 48 e o 50 da mesma
   * blusa comprou UMA peça em dois tamanhos, e perguntar duas vezes a mesma
   * coisa é o jeito mais rápido de ela fechar a aba.
   */
  async porToken(token: string) {
    const convite = await (this.prisma as any).avaliacaoConvite.findUnique({
      where: { token: String(token || '').trim() },
      include: {
        avaliacoes: true,
        order: {
          select: {
            id: true, wcOrderNumber: true, customerName: true, customerCpf: true,
            deliveredAt: true, shippingAddress: true,
            items: { select: { id: true, sku: true, ref: true, cor: true, tamanho: true, productName: true } },
          },
        },
      },
    });
    if (!convite) throw new NotFoundException('Link inválido ou expirado');
    if (convite.expiraEm && convite.expiraEm.getTime() < Date.now()) {
      throw new BadRequestException('Este link de avaliação expirou.');
    }

    // Primeira abertura: registra pra medir quem abre e não responde — sem isso
    // "ninguém avalia" e "ninguém abriu" viram o mesmo número.
    if (!convite.abertoEm) {
      await (this.prisma as any).avaliacaoConvite
        .updateMany({ where: { id: convite.id, abertoEm: null }, data: { abertoEm: new Date() } })
        .catch(() => null);
    }

    const cfg = await this.lerConfig();
    const grupos = new Map<string, any>();
    for (const item of convite.order?.items || []) {
      const base = refBaseOf(item.ref || item.sku);
      if (!base) continue;
      // Cor VAZIA, nunca nula — é a mesma normalização da coluna, e é ela que
      // faz o `@@unique` do banco valer pra peça sem cor cadastrada.
      const cor = String(item.cor || '').trim().toUpperCase();
      const chave = `${base}|${cor}`;
      const atual = grupos.get(chave);
      if (atual) {
        if (item.tamanho && !atual.tamanhos.includes(item.tamanho)) atual.tamanhos.push(item.tamanho);
        continue;
      }
      grupos.set(chave, {
        chave,
        refBase: base,
        ref: item.ref || item.sku || null,
        cor,
        tamanhos: item.tamanho ? [item.tamanho] : [],
        nome: item.productName || item.ref || base,
        orderItemId: item.id,
      });
    }

    const bases = [...new Set([...grupos.values()].map((g) => g.refBase))];
    const [produtos, fotos] = await Promise.all([
      bases.length
        ? (this.prisma as any).siteProduto.findMany({
            where: { ref: { in: bases } },
            select: { ref: true, slug: true, nome: true },
          })
        : [],
      bases.length
        ? (this.prisma as any).productPhoto.findMany({
            where: { ref: { in: bases } },
            select: { ref: true, cor: true, url: true, ordem: true },
            orderBy: { ordem: 'asc' },
          })
        : [],
    ]);
    const porRef = new Map(produtos.map((p: any) => [p.ref, p]));
    const fotoDe = (ref: string, cor: string | null) =>
      fotos.find((f: any) => f.ref === ref && (cor ? f.cor === cor : true))?.url ??
      fotos.find((f: any) => f.ref === ref)?.url ??
      null;

    const respondidas = new Map(
      (convite.avaliacoes || []).map((a: any) => [`${a.refBase}|${a.cor ?? ''}`, a]),
    );
    /** A tela mostra "sem cor" como ausência, não como string vazia. */
    const corVisivel = (c: string) => c || null;

    return {
      token: convite.token,
      pedido: convite.order?.wcOrderNumber ?? null,
      cliente: String(convite.nomeCliente || convite.order?.customerName || '').split(/\s+/)[0] || null,
      entregueEm: convite.entregueEm?.toISOString?.() ?? convite.order?.deliveredAt?.toISOString?.() ?? null,
      respondidoEm: convite.respondidoEm?.toISOString?.() ?? null,
      /** Sem CPF no pedido a página pergunta — senão não há onde creditar. */
      precisaCpf: !convite.cpf && !PontosService.cpfValido(convite.order?.customerCpf),
      regras: {
        pontosPorAvaliacao: cfg.pontosPorAvaliacao,
        pontosComFoto: cfg.pontosPorAvaliacao * cfg.multiplicadorFoto,
        pontosPorReal: cfg.pontosPorReal,
        minimoResgate: cfg.minimoResgate,
      },
      saldoAtual: await this.pontos.saldo(convite.cpf || convite.order?.customerCpf || ''),
      pecas: [...grupos.values()].map((g) => {
        const ja: any = respondidas.get(g.chave);
        const p: any = porRef.get(g.refBase);
        return {
          chave: g.chave,
          refBase: g.refBase,
          cor: corVisivel(g.cor),
          tamanho: g.tamanhos.join(' · ') || null,
          nome: p?.nome || g.nome,
          slug: p?.slug ?? null,
          foto: fotoDe(g.refBase, g.cor),
          avaliada: ja
            ? {
                nota: ja.nota,
                comentario: ja.comentario,
                temFoto: !!ja.fotoUrl,
                status: ja.status,
                pontos: ja.pontos,
              }
            : null,
        };
      }),
    };
  }

  /**
   * Pede um endereço de upload direto pro Cloudflare Images.
   *
   * O arquivo NUNCA passa pelo nosso backend: o navegador manda direto pro
   * Cloudflare e devolve só o id. É o mesmo caminho das fotos de produto — o
   * que muda é que aqui a credencial é o token do convite, então o
   * `resourceKey` amarra a imagem AO CONVITE e é conferido na hora de gravar.
   */
  async prepararFoto(token: string, filename: string) {
    const convite = await (this.prisma as any).avaliacaoConvite.findUnique({
      where: { token: String(token || '').trim() },
      select: { id: true, expiraEm: true, avaliacoes: { select: { id: true } } },
    });
    if (!convite) throw new NotFoundException('Link inválido ou expirado');
    if (convite.expiraEm && convite.expiraEm.getTime() < Date.now()) {
      throw new BadRequestException('Este link de avaliação expirou.');
    }
    if ((convite.avaliacoes?.length ?? 0) >= PosVendaService.MAX_FOTOS) {
      throw new BadRequestException('Limite de fotos atingido para este pedido.');
    }
    const nome = String(filename || 'foto.jpg').slice(0, 120);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const r = await this.cloudflare.createDirectUpload(
      { kind: 'avaliacao', resourceKey: `convite:${convite.id}`, filename: nome },
      expiresAt,
    );
    return { ...r, expiresAt: expiresAt.toISOString() };
  }

  /** Confere que a imagem foi enviada POR ESTE convite e devolve a URL pública. */
  private async urlDaFoto(conviteId: string, fotoId?: string | null): Promise<string | null> {
    const id = String(fotoId || '').trim();
    if (!id) return null;
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) throw new BadRequestException('Foto inválida');
    try {
      const img = await this.cloudflare.get(id);
      if (String(img.meta?.resourceKey || '') !== `convite:${conviteId}`) {
        throw new BadRequestException('Essa foto não pertence a este pedido');
      }
      return img.variants?.[0] ?? null;
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(`[pos-venda] foto ${id} não confirmada: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * Grava as respostas. Nasce tudo `pending` e nada aparece no site até alguém
   * aprovar — decisão do dono (19/08).
   *
   * Reenviar o formulário ATUALIZA a resposta daquela peça em vez de criar
   * outra (unique convite+refBase+cor): a cliente que voltou pra corrigir a
   * nota não deve virar duas avaliações da mesma peça.
   */
  async registrarAvaliacoes(
    token: string,
    body: {
      itens?: Array<{ refBase?: string; cor?: string | null; nota?: number; comentario?: string; fotoId?: string }>;
      cpf?: string;
    },
  ) {
    const cfg = await this.lerConfig();
    if (!cfg.ativo) throw new BadRequestException('As avaliações estão temporariamente fora do ar.');

    const convite = await (this.prisma as any).avaliacaoConvite.findUnique({
      where: { token: String(token || '').trim() },
      include: {
        order: {
          select: {
            id: true, customerCpf: true, customerName: true, customerPhone: true,
            personId: true, shippingAddress: true,
            items: { select: { id: true, sku: true, ref: true, cor: true, tamanho: true, productName: true } },
          },
        },
      },
    });
    if (!convite) throw new NotFoundException('Link inválido ou expirado');
    if (convite.expiraEm && convite.expiraEm.getTime() < Date.now()) {
      throw new BadRequestException('Este link de avaliação expirou.');
    }

    const itens = Array.isArray(body?.itens) ? body.itens : [];
    if (!itens.length) throw new BadRequestException('Escolha ao menos uma peça pra avaliar.');

    // As peças que ESTE pedido comprou — é a lista fechada do que dá pra avaliar.
    const doPedido = new Map<string, any>();
    for (const item of convite.order?.items || []) {
      const base = refBaseOf(item.ref || item.sku);
      if (!base) continue;
      const cor = String(item.cor || '').trim().toUpperCase();
      if (!doPedido.has(`${base}|${cor}`)) {
        doPedido.set(`${base}|${cor}`, { ...item, refBase: base, corNorm: cor });
      }
    }

    const cpf =
      PontosService.cpfValido(convite.cpf) ??
      PontosService.cpfValido(convite.order?.customerCpf) ??
      PontosService.cpfValido(body?.cpf);

    // Cidade/UF pra assinar a avaliação na PDP ("Ana · Campinas/SP").
    let cidadeUf: string | null = null;
    try {
      const e = JSON.parse(convite.order?.shippingAddress || '{}');
      const cidade = String(e?.city || e?.cidade || '').trim();
      const uf = String(e?.state || e?.uf || '').trim().toUpperCase();
      cidadeUf = cidade ? `${cidade}${uf ? `/${uf}` : ''}`.slice(0, 60) : null;
    } catch { /* endereço fora do formato não impede avaliação */ }

    const autor = String(convite.nomeCliente || convite.order?.customerName || '')
      .trim().split(/\s+/)[0]?.slice(0, 40) || null;

    const salvas: any[] = [];
    for (const entrada of itens) {
      const base = refBaseOf(entrada?.refBase);
      const cor = String(entrada?.cor || '').trim().toUpperCase();
      const peca = doPedido.get(`${base}|${cor}`);
      if (!peca) continue; // peça que não é deste pedido: ignora em silêncio

      const nota = Math.trunc(Number(entrada?.nota) || 0);
      if (nota < 1 || nota > 5) continue;

      const comentario = String(entrada?.comentario || '').trim().slice(0, 1500) || null;
      const fotoId = String(entrada?.fotoId || '').trim() || null;
      const fotoUrl = fotoId ? await this.urlDaFoto(convite.id, fotoId) : null;

      const dados = {
        conviteId: convite.id,
        orderId: convite.orderId,
        orderItemId: peca.id,
        cpf,
        personId: convite.order?.personId ?? null,
        refBase: base,
        ref: peca.ref || peca.sku || null,
        cor,
        tamanho: peca.tamanho ?? null,
        produtoNome: peca.productName ?? null,
        nota,
        comentario,
        fotoUrl,
        fotoId: fotoUrl ? fotoId : null,
        autorNome: autor,
        autorCidade: cidadeUf,
        status: 'pending',
      };

      const salva = await (this.prisma as any).produtoAvaliacao.upsert({
        where: { conviteId_refBase_cor: { conviteId: convite.id, refBase: base, cor } },
        create: dados,
        // Reavaliar volta pra fila: texto/foto novos não podem herdar aprovação
        // antiga — seria publicar conteúdo que ninguém leu.
        update: { ...dados, moderadoEm: null, moderadoPor: null, motivo: null },
      });
      salvas.push(salva);
    }

    if (!salvas.length) throw new BadRequestException('Nenhuma peça válida pra avaliar neste pedido.');

    await (this.prisma as any).avaliacaoConvite.update({
      where: { id: convite.id },
      data: { respondidoEm: new Date(), ...(cpf && !convite.cpf ? { cpf } : {}) },
    });

    const previstos = salvas.reduce(
      (s, a) => s + cfg.pontosPorAvaliacao * (a.fotoUrl ? cfg.multiplicadorFoto : 1),
      0,
    );
    return {
      ok: true,
      avaliadas: salvas.length,
      comFoto: salvas.filter((a) => !!a.fotoUrl).length,
      pontosPrevistos: previstos,
      /** Sem CPF não há onde creditar — a tela diz isso em vez de prometer. */
      creditaPontos: !!cpf,
      saldoAtual: cpf ? await this.pontos.saldo(cpf) : 0,
    };
  }

  // ─────────────────────────── a PDP ───────────────────────────

  /** Média, total e distribuição das APROVADAS desta família de REF. */
  async resumoDoProduto(refBaseRaw: string) {
    const refBase = refBaseOf(refBaseRaw);
    if (!refBase) return { refBase: '', media: 0, total: 0, distribuicao: {} as Record<string, number> };
    const linhas: any[] = await (this.prisma as any).produtoAvaliacao.groupBy({
      by: ['nota'],
      where: { refBase, status: 'approved' },
      _count: { _all: true },
    });
    let soma = 0;
    let total = 0;
    const distribuicao: Record<string, number> = {};
    for (const l of linhas) {
      const n = l._count._all;
      distribuicao[String(l.nota)] = n;
      soma += l.nota * n;
      total += n;
    }
    return {
      refBase,
      total,
      media: total ? Math.round((soma / total) * 10) / 10 : 0,
      distribuicao,
    };
  }

  /** As avaliações que a PDP mostra — foto primeiro, porque foto é o que vende. */
  async avaliacoesDoProduto(refBaseRaw: string, limite = 12) {
    const refBase = refBaseOf(refBaseRaw);
    if (!refBase) return [];
    const linhas: any[] = await (this.prisma as any).produtoAvaliacao.findMany({
      where: { refBase, status: 'approved' },
      orderBy: [{ fotoUrl: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: Math.min(50, Math.max(1, limite)),
      select: {
        id: true, nota: true, comentario: true, fotoUrl: true, cor: true,
        tamanho: true, autorNome: true, autorCidade: true, createdAt: true,
      },
    });
    return linhas.map((a) => ({
      id: a.id,
      nota: a.nota,
      comentario: a.comentario,
      foto: a.fotoUrl,
      cor: a.cor || null,
      tamanho: a.tamanho,
      autor: a.autorNome,
      cidade: a.autorCidade,
      data: a.createdAt?.toISOString?.() ?? null,
      /** Toda avaliação nasce de um pedido ENTREGUE — a PDP pode dizer isso. */
      compraVerificada: true,
    }));
  }

  // ─────────────────────────── a retaguarda ───────────────────────────

  /**
   * SÓ OS DOIS NÚMEROS DO BADGE — o que exige gente.
   *
   * Separado da `fila()` porque a tela de separação recarrega os contadores a
   * cada 30 segundos, em todo PC de matriz aberto: puxar 300 pedidos com
   * avaliações aninhadas nesse ritmo seria gastar banco pra desenhar um número
   * de dois dígitos.
   */
  async resumoDoBadge(): Promise<{ aEnviar: number; aModerar: number }> {
    const cfg = await this.lerConfig();
    const agora = Date.now();
    const [aEnviar, aModerar] = await Promise.all([
      (this.prisma as any).order.count({
        where: {
          status: 'delivered',
          source: { in: ORIGENS_POS_VENDA },
          deliveredAt: {
            gte: new Date(agora - cfg.janelaDias * 86_400_000),
            lte: new Date(agora - cfg.diasAposEntrega * 86_400_000),
          },
          // Sem convite, ou com convite que nunca saiu — os dois são "ninguém
          // chamou essa cliente ainda".
          OR: [{ avaliacaoConvite: null }, { avaliacaoConvite: { enviadoEm: null } }],
        },
      }),
      (this.prisma as any).produtoAvaliacao.count({ where: { status: 'pending' } }),
    ]);
    return { aEnviar, aModerar };
  }

  /**
   * A aba "Pós-venda": o ciclo inteiro numa lista só — quem foi entregue, quem
   * já foi chamado, quem respondeu e o que está esperando aprovação.
   */
  async fila(params: { de?: string; ate?: string; situacao?: string; busca?: string }) {
    const cfg = await this.lerConfig();
    const de = params.de ? new Date(`${params.de}T00:00:00`) : new Date(Date.now() - 30 * 86_400_000);
    const ate = params.ate ? new Date(`${params.ate}T23:59:59`) : new Date();

    const pedidos: any[] = await (this.prisma as any).order.findMany({
      where: {
        AND: [
          { status: 'delivered' },
          { deliveredAt: { gte: de, lte: ate } },
          { source: { in: ORIGENS_POS_VENDA } },
          ...(params.busca
            ? [
                {
                  OR: [
                    { wcOrderNumber: { contains: params.busca, mode: 'insensitive' } },
                    { customerName: { contains: params.busca, mode: 'insensitive' } },
                    { customerPhone: { contains: params.busca } },
                  ],
                },
              ]
            : []),
        ],
      },
      select: {
        id: true, wcOrderNumber: true, customerName: true, customerPhone: true,
        customerCpf: true, deliveredAt: true, source: true, totalAmount: true,
        avaliacaoConvite: {
          select: {
            id: true, token: true, enviadoEm: true, abertoEm: true, respondidoEm: true,
            tentativas: true, expiraEm: true,
            avaliacoes: {
              select: {
                id: true, refBase: true, cor: true, tamanho: true, produtoNome: true,
                nota: true, comentario: true, fotoUrl: true, status: true, pontos: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
      orderBy: { deliveredAt: 'desc' },
      take: 300,
    });

    const prazo = cfg.diasAposEntrega * 86_400_000;
    const linhas = pedidos.map((p) => {
      const c = p.avaliacaoConvite;
      const avaliacoes = c?.avaliacoes ?? [];
      const pendentes = avaliacoes.filter((a: any) => a.status === 'pending').length;
      const venceEm = p.deliveredAt ? new Date(p.deliveredAt).getTime() + prazo : null;
      const situacao = !c
        ? venceEm && venceEm <= Date.now()
          ? 'a_enviar'
          : 'aguardando_prazo'
        : !c.enviadoEm
          ? 'a_enviar'
          : !c.respondidoEm
            ? 'convidada'
            : pendentes
              ? 'a_moderar'
              : 'concluida';
      return {
        orderId: p.id,
        pedido: p.wcOrderNumber,
        cliente: p.customerName,
        telefone: p.customerPhone,
        temCpf: !!PontosService.cpfValido(p.customerCpf),
        origem: p.source,
        total: p.totalAmount ?? null,
        entregueEm: p.deliveredAt?.toISOString?.() ?? null,
        convidarEm: venceEm ? new Date(venceEm).toISOString() : null,
        conviteId: c?.id ?? null,
        link: c ? this.linkDoConvite(c.token) : null,
        enviadoEm: c?.enviadoEm?.toISOString?.() ?? null,
        abertoEm: c?.abertoEm?.toISOString?.() ?? null,
        respondidoEm: c?.respondidoEm?.toISOString?.() ?? null,
        tentativas: c?.tentativas ?? 0,
        situacao,
        pendentes,
        avaliacoes: avaliacoes.map((a: any) => ({
          id: a.id,
          refBase: a.refBase,
          cor: a.cor || null,
          tamanho: a.tamanho,
          produto: a.produtoNome,
          nota: a.nota,
          comentario: a.comentario,
          foto: a.fotoUrl,
          status: a.status,
          pontos: a.pontos,
          data: a.createdAt?.toISOString?.() ?? null,
        })),
      };
    });

    const filtradas = params.situacao ? linhas.filter((l) => l.situacao === params.situacao) : linhas;
    return {
      config: cfg,
      resumo: {
        entregues: linhas.length,
        aEnviar: linhas.filter((l) => l.situacao === 'a_enviar').length,
        convidadas: linhas.filter((l) => l.situacao === 'convidada').length,
        aModerar: linhas.filter((l) => l.situacao === 'a_moderar').length,
        concluidas: linhas.filter((l) => l.situacao === 'concluida').length,
        respondidas: linhas.filter((l) => !!l.respondidoEm).length,
      },
      linhas: filtradas,
    };
  }

  /**
   * Aprova ou reprova — e é a APROVAÇÃO que paga os pontos.
   *
   * A trava de idempotência mora no extrato (`@@unique(tipo, origem)`): dois
   * cliques no mesmo botão não creditam duas vezes.
   */
  async moderar(
    id: string,
    decisao: 'approved' | 'rejected',
    opcoes: { motivo?: string; quem?: string } = {},
  ) {
    const cfg = await this.lerConfig();
    const a = await (this.prisma as any).produtoAvaliacao.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Avaliação não encontrada');

    if (decisao === 'rejected') {
      await (this.prisma as any).produtoAvaliacao.update({
        where: { id },
        data: {
          status: 'rejected',
          motivo: opcoes.motivo?.slice(0, 160) ?? null,
          moderadoEm: new Date(),
          moderadoPor: opcoes.quem?.slice(0, 80) ?? null,
        },
      });
      return { ok: true, status: 'rejected', pontos: 0 };
    }

    const pontos = cfg.pontosPorAvaliacao * (a.fotoUrl ? cfg.multiplicadorFoto : 1);
    const credito = a.cpf
      ? await this.pontos.lancar({
          cpf: a.cpf,
          pontos,
          tipo: 'avaliacao',
          origem: `avaliacao:${a.id}`,
          descricao: `Avaliação de ${a.produtoNome || a.refBase}${a.fotoUrl ? ' (com foto)' : ''}`,
          nome: a.autorNome,
        })
      : { ok: false, saldo: 0 };

    await (this.prisma as any).produtoAvaliacao.update({
      where: { id },
      data: {
        status: 'approved',
        motivo: null,
        moderadoEm: new Date(),
        moderadoPor: opcoes.quem?.slice(0, 80) ?? null,
        ...(credito.ok ? { pontos, pontosEm: new Date() } : {}),
      },
    });
    return { ok: true, status: 'approved', pontos: credito.ok ? pontos : 0, saldo: credito.saldo };
  }

  async moderarLote(ids: string[], decisao: 'approved' | 'rejected', quem?: string) {
    let ok = 0;
    const erros: string[] = [];
    for (const id of ids.slice(0, 100)) {
      try {
        await this.moderar(id, decisao, { quem });
        ok++;
      } catch (e: any) {
        erros.push(`${id}: ${e?.message || e}`);
      }
    }
    return { ok, total: Math.min(ids.length, 100), erros };
  }
}
