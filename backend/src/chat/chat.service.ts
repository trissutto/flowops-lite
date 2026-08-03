import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { LojaCatalogService } from '../loja-catalog/loja-catalog.service';
import { CustomersAppService } from '../customers-app/customers-app.service';
import { systemPrompt } from './persona';

/**
 * ASSISTENTE DO SITE — o chat de atendimento da vitrine.
 *
 * Claude com FERRAMENTAS, e não um chat solto: a regra "nunca invente produto"
 * só vale de verdade se ela tiver como CONSULTAR o catálogo. Sem ferramenta,
 * qualquer modelo inventa uma blusa plausível — e a cliente descobre no
 * carrinho.
 *
 * As ferramentas são todas de LEITURA, com uma exceção: chamar_consultora, que
 * grava o pedido de atendimento humano na fila da retaguarda.
 *
 * Custo e abuso: endpoint público que chama IA é convite pra queimar crédito.
 * Defesas — teto de mensagens por conversa, teto de tokens por resposta,
 * histórico truncado e rate-limit por sessão no controller.
 */

type Papel = 'cliente' | 'assistente';
interface Mensagem { papel: Papel; texto: string; em: string }

const MAX_MENSAGENS = 40;
const MAX_HISTORICO = 16;
const MAX_RODADAS_FERRAMENTA = 4;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly modeloPadrao = 'claude-sonnet-5';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly catalogo: LojaCatalogService,
    private readonly clientes: CustomersAppService,
  ) {}

  private get apiKey(): string | null {
    const k = this.config.get<string>('ANTHROPIC_API_KEY');
    return k && k.trim() ? k.trim() : null;
  }

  isEnabled(): boolean {
    return !!this.apiKey;
  }

  /** Contrato das ferramentas — o que a assistente pode consultar. */
  private ferramentas(logada: boolean) {
    const lista: any[] = [
      {
        name: 'buscar_produtos',
        description:
          'Procura peças no catálogo REAL da loja. Use SEMPRE antes de indicar qualquer peça. ' +
          'Devolve nome, preço, cores, tamanhos disponíveis e o link da página.',
        input_schema: {
          type: 'object',
          properties: {
            busca: { type: 'string', description: 'Texto livre: "vestido festa", "calça alfaiataria preta"' },
            categoria: { type: 'string', description: 'vestidos, blusas, calcas, saias, conjuntos...' },
            tamanho: { type: 'string', description: 'Filtra por tamanho disponível: "48"' },
            precoMax: { type: 'number' },
          },
        },
      },
      {
        name: 'ver_peca',
        description:
          'Detalhe de uma peça pelo slug devolvido na busca: cores, grade de tamanhos POR COR com ' +
          'disponibilidade, e medidas quando estiverem cadastradas.',
        input_schema: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
      },
      {
        name: 'chamar_consultora',
        description:
          'Coloca a conversa na fila de atendimento humano. Use quando a dúvida for complexa, ' +
          'envolver pedido já feito, ou a cliente pedir. Peça nome e WhatsApp ANTES de chamar.',
        input_schema: {
          type: 'object',
          properties: {
            nome: { type: 'string' },
            whatsapp: { type: 'string', description: 'Com DDD, só dígitos' },
            resumo: { type: 'string', description: 'O que a cliente precisa, em uma frase' },
          },
          required: ['nome', 'whatsapp', 'resumo'],
        },
      },
    ];

    if (logada) {
      lista.push({
        name: 'meus_pedidos',
        description: 'Pedidos da cliente logada: número, status, data, valor e rastreio.',
        input_schema: { type: 'object', properties: {} },
      });
    }
    return lista;
  }

  private async executarFerramenta(
    nome: string,
    entrada: any,
    ctx: { chatId: string; accountId?: string | null; contexto?: string | null },
  ): Promise<unknown> {
    switch (nome) {
      case 'buscar_produtos': {
        const r = await this.catalogo.listar({
          busca: entrada?.busca,
          categoria: entrada?.categoria,
          tamanho: entrada?.tamanho,
          precoMax: entrada?.precoMax,
          soDisponivel: true,
          perPage: 6,
        });
        // Só o que ajuda a responder: payload cheio gasta contexto e não muda
        // a resposta.
        return (r.itens ?? []).map((p: any) => ({
          nome: p.nome,
          preco: p.preco,
          link: `/produto/${p.slug}`,
          slug: p.slug,
          cores: (p.cores ?? []).map((c: any) => c.nome),
          tamanhos: (p.tamanhos ?? []).filter((t: any) => t.disponivel).map((t: any) => t.label),
        }));
      }

      case 'ver_peca': {
        const p: any = await this.catalogo.porSlug(String(entrada?.slug || ''));
        if (!p) return { erro: 'peça não encontrada' };
        return {
          nome: p.nome,
          preco: p.preco,
          link: `/produto/${p.slug}`,
          descricao: p.descricaoCurta ?? null,
          cores: (p.cores ?? []).map((c: any) => ({
            cor: c.nome,
            preco: c.preco,
            tamanhos: (c.tamanhos ?? []).filter((t: any) => t.disponivel).map((t: any) => t.label),
          })),
          medidas: p.medidas ?? null,
          modelagem: p.modelagem ?? null,
          composicao: p.composicao ?? null,
        };
      }

      case 'meus_pedidos': {
        // `Order` não tem customerId: o vínculo é por CPF + os links da conta.
        // Quem sabe fazer esse cruzamento é o CustomersAppService — refazer a
        // query aqui daria uma segunda verdade sobre "os pedidos dela".
        if (!ctx.accountId) return { erro: 'cliente não está logada' };
        const r: any = await this.clientes.getOrders(ctx.accountId);
        return (r?.orders ?? []).slice(0, 5).map((o: any) => ({
          numero: o.number,
          status: o.status,
          total: o.total,
          data: o.date,
          rastreio: o.tracking ? { codigo: o.tracking.code, transportadora: o.tracking.carrier } : null,
        }));
      }

      case 'chamar_consultora': {
        const whatsapp = String(entrada?.whatsapp || '').replace(/\D/g, '');
        if (whatsapp.length < 10) return { erro: 'WhatsApp incompleto — peça com DDD' };
        await (this.prisma as any).siteChat.update({
          where: { id: ctx.chatId },
          data: {
            status: 'aguardando',
            nome: String(entrada?.nome || '').trim() || null,
            whatsapp,
            contexto: [ctx.contexto, String(entrada?.resumo || '').trim()].filter(Boolean).join(' · ') || null,
          },
        });
        this.logger.log(`[chat] consultora chamada — chat ${ctx.chatId}`);
        return { ok: true, aviso: 'A equipe foi avisada e entra em contato pelo WhatsApp.' };
      }

      default:
        return { erro: 'ferramenta desconhecida' };
    }
  }

  /**
   * Uma rodada de conversa. Devolve a resposta da assistente e o id do chat
   * (o navegador guarda pra continuar).
   */
  async responder(input: {
    chatId?: string | null;
    sessaoId: string;
    mensagem: string;
    contexto?: string | null;
    accountId?: string | null;
  }): Promise<{ chatId: string; resposta: string; pediuConsultora: boolean }> {
    if (!this.apiKey) {
      throw new BadRequestException('Atendimento automático indisponível no momento.');
    }
    const texto = String(input.mensagem || '').trim().slice(0, 1000);
    if (!texto) throw new BadRequestException('Escreva sua dúvida.');

    // Recupera (ou cria) a conversa
    let chat = input.chatId
      ? await (this.prisma as any).siteChat.findUnique({ where: { id: input.chatId } })
      : null;
    if (!chat) {
      chat = await (this.prisma as any).siteChat.create({
        data: {
          sessaoId: String(input.sessaoId || 'anon').slice(0, 80),
          customerId: input.accountId ?? null,
          mensagens: '[]',
          contexto: input.contexto ?? null,
        },
      });
    }

    const historico: Mensagem[] = (() => {
      try { return JSON.parse(chat.mensagens || '[]'); } catch { return []; }
    })();
    if (historico.length >= MAX_MENSAGENS) {
      return {
        chatId: chat.id,
        resposta:
          'Nossa conversa ficou longa — pra te ajudar direito, prefiro chamar uma consultora. ' +
          'Me passa seu nome e WhatsApp?',
        pediuConsultora: false,
      };
    }
    historico.push({ papel: 'cliente', texto, em: new Date().toISOString() });

    const logada = !!input.accountId;
    const mensagens: any[] = historico.slice(-MAX_HISTORICO).map((m) => ({
      role: m.papel === 'cliente' ? 'user' : 'assistant',
      content: m.texto,
    }));

    let resposta = '';
    let pediuConsultora = false;

    for (let rodada = 0; rodada < MAX_RODADAS_FERRAMENTA; rodada++) {
      const data = await this.chamarClaude({
        system: systemPrompt({ logada, contexto: input.contexto ?? chat.contexto }),
        messages: mensagens,
        tools: this.ferramentas(logada),
      });

      const blocos: any[] = data?.content ?? [];
      resposta = blocos
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text || ''))
        .join('\n')
        .trim();

      const usos = blocos.filter((b) => b?.type === 'tool_use');
      if (!usos.length) break;

      mensagens.push({ role: 'assistant', content: blocos });
      const resultados: any[] = [];
      for (const uso of usos) {
        if (uso.name === 'chamar_consultora') pediuConsultora = true;
        let saida: unknown;
        try {
          saida = await this.executarFerramenta(uso.name, uso.input, {
            chatId: chat.id,
            accountId: input.accountId,
            contexto: input.contexto ?? chat.contexto,
          });
        } catch (e: any) {
          this.logger.warn(`[chat] ferramenta ${uso.name} falhou: ${e?.message || e}`);
          saida = { erro: 'não consegui consultar agora' };
        }
        resultados.push({
          type: 'tool_result',
          tool_use_id: uso.id,
          content: JSON.stringify(saida).slice(0, 6000),
        });
      }
      mensagens.push({ role: 'user', content: resultados });
    }

    if (!resposta) {
      resposta = 'Me conta um pouquinho mais? Assim eu te ajudo melhor.';
    }

    historico.push({ papel: 'assistente', texto: resposta, em: new Date().toISOString() });
    await (this.prisma as any).siteChat.update({
      where: { id: chat.id },
      data: { mensagens: JSON.stringify(historico.slice(-MAX_MENSAGENS)) },
    });

    return { chatId: chat.id, resposta, pediuConsultora };
  }

  private async chamarClaude(body: { system: string; messages: any[]; tools: any[] }) {
    try {
      const res = await firstValueFrom(
        this.http.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: this.config.get<string>('CHAT_MODEL') || this.modeloPadrao,
            max_tokens: 700,
            system: body.system,
            messages: body.messages,
            tools: body.tools,
          },
          {
            headers: {
              'x-api-key': this.apiKey!,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            timeout: 45000,
          },
        ),
      );
      return res.data;
    } catch (e: any) {
      this.logger.warn(`[chat] Anthropic falhou (${e?.response?.status}): ${e?.message}`);
      throw new BadRequestException(
        'Não consegui responder agora. Se preferir, posso chamar uma consultora.',
      );
    }
  }

  /* ─────────────────────── Retaguarda ─────────────────────── */

  async fila(status?: string) {
    return (this.prisma as any).siteChat.findMany({
      where: status ? { status } : { status: { in: ['aguardando', 'atendida'] } },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 100,
    });
  }

  async marcarAtendida(id: string, quem: string) {
    return (this.prisma as any).siteChat.update({
      where: { id },
      data: { status: 'atendida', atendidaPor: quem, atendidaEm: new Date() },
    });
  }
}
