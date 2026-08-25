import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CorreiosService } from '../correios/correios.service';
import { MaisEnviosService } from '../mais-envios/mais-envios.service';
import { caixaDoSite } from '../common/caixa-site';

/**
 * tracking.service.ts — status de entrega do objeto, em cascata (18/08).
 *
 * ⚠️ ANTES DESTA VERSÃO O RASTREIO NÃO FUNCIONAVA — e ninguém via.
 * O provedor era o LinkeTrack, cujo `LINKETRACK_TOKEN` nunca foi configurado
 * em produção: toda consulta caía no modo degradado ("configure o token"). O
 * caminho dos Correios, usado pelos crons, respondia HTTP 400 em 100% das
 * chamadas por falta do header `Accept-Language` (ver `CorreiosService`).
 * Resultado medido: 3 avisos de "seu pedido chegou" em 22.678 pedidos e
 * NENHUM pedido `delivered` em 90 dias.
 *
 * A CASCATA, e por que ela existe: a casa emite etiqueta por DOIS caminhos.
 *   1. contrato próprio dos Correios → responde no SRO;
 *   2. Mais Envios (a maioria hoje) → o SRO devolve "SRO-009: objeto não
 *      pertence ao contrato" com zero eventos; quem sabe é a API deles.
 * Nenhum dos dois cobre tudo, então tenta um e cai no outro. LinkeTrack fica
 * como terceira opção, só se algum dia o token existir.
 *
 * Toda consulta bem-sucedida grava em `rastreio_objetos` — é de lá que as
 * LISTAS leem (a tela da loja mostra dezenas de cards e recarrega sozinha;
 * consultar a API por card viraria dezenas de requests por render).
 */

export interface TrackingEvent {
  date: string;           // "18/08/2026"
  time: string;           // "15:26"
  location: string;       // "CAMPINAS/SP"
  description: string;    // "Objeto entregue ao destinatário"
  isDelivery: boolean;    // true só na entrega de fato
}

export interface TrackingResult {
  code: string;
  carrier: string;
  service: string | null;
  events: TrackingEvent[];
  lastStatus: string | null;
  delivered: boolean;
  fetchedAt: string;
  provider: string;
  /** ISO da entrega, quando o rastreio confirma. */
  deliveredAt?: string | null;
  /** ISO da previsão de entrega (o SRO devolve `dtPrevista`). */
  estimatedAt?: string | null;
  /** "PAC - Encomenda Econômica" — a descrição longa do serviço, quando vem. */
  serviceDesc?: string | null;
  /**
   * Peso do objeto em GRAMAS, quando o provedor manda.
   * ⚠️ O SRO manda gramas ("450") e o Mais Envios manda quilos (0.45): ver
   * `pesoEmGramas`, que decide pela ordem de grandeza.
   */
  weightGrams?: number | null;
  /**
   * ISO da POSTAGEM (evento "Objeto postado").
   * O relógio do prazo dos Correios começa AQUI, não na emissão da etiqueta —
   * etiqueta emitida e caixa em cima do balcão é o caso do dia (a remessa
   * REM-732 ficou 8 dias assim).
   */
  postedAt?: string | null;
  /** Cidade/UF de onde o objeto foi postado. */
  origin?: string | null;
  /** Cidade/UF pra onde ele está indo (unidadeDestino do evento mais recente). */
  destination?: string | null;
  error?: string;
}

/** O que as LISTAS mostram — uma linha por objeto, direto do cache. */
export type RastreioResumo = {
  codigo: string;
  status: string | null;
  local: string | null;
  eventoEm: Date | null;
  previsaoEm: Date | null;
  entregue: boolean;
  entregueEm: Date | null;
  consultadoEm: Date | null;
};

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly correios: CorreiosService,
    private readonly maisEnvios: MaisEnviosService,
  ) {}

  private get token(): string | undefined {
    return process.env.LINKETRACK_TOKEN;
  }

  private get user(): string {
    return process.env.LINKETRACK_USER || 'teste';
  }

  /** Código de objeto dos Correios. O campo é texto livre na mão da loja. */
  static ehCodigoValido(code: string | null | undefined): boolean {
    return /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(String(code || '').trim().toUpperCase());
  }

  /**
   * 🔴 O CÓDIGO CERTO, DIGITADO ERRADO (22/08).
   *
   * A loja digita o rastreio na mão, e um em cada dez sai com espaço ou em
   * minúscula: "AD 717 071 708 BR", "ad718148023br", "aN856224448BR". Nada
   * disso passa no `ehCodigoValido`, então o objeto NUNCA é consultado, o
   * pedido nunca fecha e ele fica preso em "Em trânsito" até envelhecer pros
   * 30 dias e cair em "Concluídos" sem ninguém ter confirmado a entrega.
   *
   * Medido na base inteira: **1.026 códigos fora do padrão em `orders`
   * (+1.061 em `pick_orders`), e 914 deles viram etiqueta válida só tirando
   * espaço e subindo pra maiúscula** — 913 estavam em `shipped`.
   *
   * Tira espaço, ponto e hífen (as três formas que aparecem no copia-e-cola
   * dos Correios e do Mais Envios) e sobe pra maiúscula. NÃO inventa: o que
   * não vira etiqueta válida volta como veio, e quem decide é o
   * `ehCodigoValido` de sempre. "MOTOBOY" e "retirada em loja" continuam
   * sendo o que são — esses não é digitação torta, é ausência de rastreio, e
   * o guard do `marcarEnviado` já trata.
   */
  static normalizarCodigo<T extends string | null | undefined>(code: T): T | string {
    const cru = String(code ?? '');
    if (!cru.trim()) return code;
    const limpo = cru.toUpperCase().replace(/[\s.\-]/g, '');
    return TrackingService.ehCodigoValido(limpo) ? limpo : code;
  }

  /**
   * "Entregue" de verdade.
   *
   * `/entreg/i` casa com "saiu para ENTREGA ao destinatário" (ainda no carro do
   * carteiro) e "não entregue" é tentativa falha. Errar aqui não é cosmético:
   * a data de entrega é o marco zero do prazo de troca.
   */
  private ehEntrega(descricao: string): boolean {
    const t = String(descricao || '');
    return /entregue/i.test(t) && !/n[ãa]o\s+entregue/i.test(t);
  }

  /**
   * `dtHrCriado` vem SEM fuso ("2026-08-18T15:26:03") e é horário de Brasília.
   * Deixar o `new Date()` interpretar isso com o fuso do servidor (Railway roda
   * em UTC) jogaria todo evento 3h pra trás.
   */
  private paraData(dtHrCriado: string | null | undefined): Date | null {
    const s = String(dtHrCriado || '').trim();
    if (!s) return null;
    const comFuso = /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}-03:00`;
    const d = new Date(comFuso);
    return isNaN(d.getTime()) ? null : d;
  }

  /** "2026-08-18T15:26:03" → { date: "18/08/2026", time: "15:26" } (sem Date, sem fuso). */
  private paraBr(dtHrCriado: string | null | undefined): { date: string; time: string } {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(dtHrCriado || '').trim());
    if (!m) return { date: '', time: '' };
    const [, yyyy, mm, dd, hh, mi] = m;
    return { date: `${dd}/${mm}/${yyyy}`, time: `${hh}:${mi}` };
  }

  /** "CAMPINAS/SP" a partir de uma unidade (o formato varia por provedor). */
  private localDe(unidade: any): string {
    const end = unidade?.endereco ?? {};
    const cidade = String(end.cidade || '').trim();
    const uf = String(end.uf || '').trim();
    if (cidade && uf) return `${cidade}/${uf}`;
    if (cidade) return cidade;
    const nome = String(unidade?.nome || unidade?.tipo || '').trim();
    return uf && nome ? `${nome}/${uf}` : nome || uf;
  }

  /** "CAMPINAS/SP" a partir da unidade do evento. */
  private local(ev: any): string {
    return this.localDe(ev?.unidade);
  }

  /** Postagem de fato — é daqui que o prazo dos Correios conta. */
  private ehPostagem(descricao: string): boolean {
    return /objeto\s+postado/i.test(String(descricao || ''));
  }

  /**
   * Peso do objeto em GRAMAS.
   *
   * O SRO manda gramas em texto ("450") e o Mais Envios manda quilos (0.45).
   * Não dá pra confiar no nome do campo, então decide pela ordem de grandeza:
   * peça de roupa não pesa 0,45 g nem a casa despacha caixa de 450 kg — abaixo
   * de 100 é quilo, daí pra cima é grama. Fora da faixa plausível (até 60 kg,
   * o teto dos Correios) devolve null: melhor não mostrar peso nenhum do que
   * mostrar peso errado.
   */
  private pesoEmGramas(valor: any): number | null {
    if (valor == null || valor === '') return null;
    const cru = String(valor).trim().replace(',', '.');
    const n = Number(cru.replace(/[^\d.]/g, ''));
    if (!isFinite(n) || n <= 0) return null;
    const gramas = n < 100 ? Math.round(n * 1000) : Math.round(n);
    return gramas > 0 && gramas <= 60_000 ? gramas : null;
  }

  /**
   * Eventos crus → `TrackingEvent[]` do MAIS NOVO pro mais antigo.
   *
   * A ordem não pode ser assumida: o SRO devolve decrescente e o Mais Envios
   * crescente. Quem lê pega `events[0]` como "situação agora" — invertido, o
   * card mostraria "Etiqueta emitida" num objeto já entregue.
   */
  private normalizarEventos(eventos: any[]): TrackingEvent[] {
    return (Array.isArray(eventos) ? eventos : [])
      .map((ev) => {
        const br = this.paraBr(ev?.dtHrCriado);
        const descricao = String(ev?.descricao || ev?.status || '').trim();
        return {
          date: br.date,
          time: br.time,
          location: this.local(ev),
          description: descricao,
          isDelivery: this.ehEntrega(descricao),
          quando: this.paraData(ev?.dtHrCriado)?.getTime() ?? 0,
        };
      })
      .sort((a, b) => b.quando - a.quando)
      .map(({ quando, ...ev }) => ev);
  }

  private montar(
    code: string,
    carrier: string | undefined,
    provider: string,
    dados: {
      eventos: any[];
      servico?: string | null;
      previsao?: string | null;
      servicoDesc?: string | null;
      peso?: any;
    },
  ): TrackingResult {
    const crus = Array.isArray(dados.eventos) ? dados.eventos : [];
    const events = this.normalizarEventos(crus);
    const quando = (ev: any) => this.paraData(ev?.dtHrCriado)?.getTime() ?? 0;
    // A entrega é o evento mais recente que fala em "entregue": pega a data do
    // evento CRU correspondente pra não reconstruir a partir do texto.
    const entregaCrua = crus
      .filter((ev) => this.ehEntrega(String(ev?.descricao || ev?.status || '')))
      .sort((a, b) => quando(b) - quando(a))[0];
    // A POSTAGEM é a mais ANTIGA (o objeto pode ser repostado depois de uma
    // devolução ao remetente) — é ela que marca o começo do prazo.
    const postagemCrua = crus
      .filter((ev) => this.ehPostagem(String(ev?.descricao || ev?.status || '')))
      .sort((a, b) => quando(a) - quando(b))[0];
    // Pra onde vai: o SRO carimba `unidadeDestino` nos eventos de trânsito.
    const destinoCru = [...crus]
      .sort((a, b) => quando(b) - quando(a))
      .find((ev) => this.localDe(ev?.unidadeDestino));
    return {
      code,
      carrier: carrier || 'correios',
      service: dados.servico ?? null,
      serviceDesc: dados.servicoDesc ?? null,
      weightGrams: this.pesoEmGramas(dados.peso),
      events,
      lastStatus: events[0]?.description ?? null,
      delivered: !!entregaCrua,
      deliveredAt: entregaCrua ? this.paraData(entregaCrua.dtHrCriado)?.toISOString() ?? null : null,
      estimatedAt: dados.previsao ? this.paraData(dados.previsao)?.toISOString() ?? null : null,
      postedAt: postagemCrua ? this.paraData(postagemCrua.dtHrCriado)?.toISOString() ?? null : null,
      origin: postagemCrua ? this.local(postagemCrua) || null : null,
      destination: destinoCru ? this.localDe(destinoCru.unidadeDestino) || null : null,
      fetchedAt: new Date().toISOString(),
      provider,
    };
  }

  /**
   * "QUANTO CUSTA ESSE ENVIO HOJE" — pra tela do pedido conferir o frete
   * cobrado contra o que o transporte cobra.
   *
   * 🔴 COMPARAR COM O PROVEDOR ERRADO É PIOR QUE NÃO COMPARAR (25/08). A
   * primeira versão cotava SEMPRE nos Correios, saindo do CEP do env
   * (Itanhaém). Num pedido real — etiqueta do **Mais Envios**, postada em
   * **Vinhedo** — a tela acusou "frete no prejuízo: R$ 9,01" comparando os
   * R$ 9,99 cobrados com R$ 19,00 de uma cotação que não tinha nada a ver com
   * o envio: contrato diferente (o Mais Envios revende MAIS BARATO que o
   * balcão) e origem a 300 km de onde a caixa saiu. Alarme falso mata a
   * confiança na tela inteira — vale aqui como vale na fila da loja.
   *
   * Então: cota em QUEM emitiu a etiqueta, saindo do CEP da LOJA que postou.
   * Quando não dá pra saber a origem, a cotação continua aparecendo como
   * referência, mas SEM o veredito de prejuízo (`comparavel: false`).
   */
  async cotarFrete(input: {
    cepDestino: string;
    pecas?: number;
    /** Loja que postou (code) — o CEP de origem sai dela. */
    lojaCode?: string | null;
    /** Transportadora do pedido ("Mais Envios SEDEX", "Correios PAC"…). */
    carrier?: string | null;
    /** Código do objeto — desempata o provedor pelo cache do rastreio. */
    code?: string | null;
  }): Promise<{
    provedor: 'correios' | 'maisenvios';
    motivo: string;
    cepOrigem: string | null;
    lojaCode: string | null;
    lojaNome: string | null;
    origemPadrao: boolean;
    comparavel: boolean;
    cepDestino: string;
    pecas: number;
    pesoGramas: number | null;
    opcoes: Array<{ servico: string; codigo: string; precoReais: number | null; prazoDias: number | null; erro?: string }>;
    erro?: string;
  }> {
    const cepDestino = String(input.cepDestino || '').replace(/\D/g, '');
    if (cepDestino.length !== 8) throw new BadRequestException('CEP de destino inválido (8 dígitos).');
    const pecas = Math.min(50, Math.max(1, Math.round(Number(input.pecas) || 1)));
    const caixa = caixaDoSite(pecas);

    // 1) QUEM levou. O carrier do pedido é o que a loja escolheu na hora de
    //    gerar a etiqueta; o cache do rastreio é a segunda opinião (quem
    //    respondeu a consulta: objeto do Mais Envios volta SRO-009 no SRO).
    const carrier = String(input.carrier || '').toLowerCase();
    let provedor: 'correios' | 'maisenvios' = 'correios';
    let motivo = 'contrato próprio';
    if (/mais\s*envios|maisenvios/.test(carrier)) {
      provedor = 'maisenvios';
      motivo = 'transportadora do pedido';
    } else if (input.code) {
      const cache: any = await (this.prisma as any).rastreioObjeto
        .findUnique({ where: { codigo: String(input.code).trim().toUpperCase() }, select: { provedor: true } })
        .catch(() => null);
      if (cache?.provedor === 'maisenvios') {
        provedor = 'maisenvios';
        motivo = 'foi quem respondeu o rastreio';
      }
    }

    // 2) DE ONDE saiu. Cada loja posta do CEP dela.
    let cepOrigem: string | null = null;
    let lojaNome: string | null = null;
    const lojaCode = String(input.lojaCode || '').trim() || null;
    if (lojaCode) {
      const loja = await this.prisma.store
        .findUnique({ where: { code: lojaCode }, select: { name: true, cep: true } })
        .catch(() => null);
      if (loja) {
        lojaNome = loja.name;
        const cep = String(loja.cep || '').replace(/\D/g, '');
        if (cep.length === 8) cepOrigem = cep;
      }
    }
    const origemPadrao = !cepOrigem;

    const vazio = {
      provedor, motivo, cepOrigem, lojaCode, lojaNome, origemPadrao,
      comparavel: false, cepDestino, pecas, pesoGramas: caixa.pesoGramas,
      opcoes: [] as Array<{ servico: string; codigo: string; precoReais: number | null; prazoDias: number | null; erro?: string }>,
    };

    try {
      const r: any =
        provedor === 'maisenvios'
          ? await this.maisEnvios.calcularFrete({
              cepDestino, cepOrigem: cepOrigem ?? undefined,
              pesoGramas: caixa.pesoGramas, comprimento: caixa.comprimento,
              largura: caixa.largura, altura: caixa.altura,
            })
          : await this.correios.calcularFrete({
              cepDestino, cepOrigem: cepOrigem ?? undefined,
              pesoGramas: caixa.pesoGramas, comprimento: caixa.comprimento,
              largura: caixa.largura, altura: caixa.altura,
            });
      const opcoes = (r?.opcoes ?? []).map((o: any) => ({
        servico: o.servico, codigo: o.codigo,
        precoReais: o.precoReais ?? null, prazoDias: o.prazoDias ?? null,
        ...(o.erro ? { erro: o.erro } : {}),
      }));
      // O provedor devolve de qual CEP ele cotou (`cepOrigem` nos Correios,
      // `source` no Mais Envios) — é o que a tela mostra quando a loja não
      // veio e a cotação caiu no padrão.
      const cepUsado =
        cepOrigem || String(r?.cepOrigem ?? r?.source ?? '').replace(/\D/g, '') || null;
      return {
        ...vazio,
        cepOrigem: cepUsado,
        opcoes,
        // Veredito de prejuízo só quando os dois lados falam do MESMO envio:
        // provedor da etiqueta e CEP da loja que postou.
        comparavel: !origemPadrao && opcoes.some((o: any) => o.precoReais != null),
      };
    } catch (e: any) {
      return { ...vazio, erro: e?.message || 'falha na cotação' };
    }
  }

  /**
   * Consulta AO VIVO, na cascata. Usada pela tela do pedido, pela troca e pelo
   * cron; a lista NÃO chama aqui (lê o cache).
   */
  async fetchTracking(code: string, carrier?: string): Promise<TrackingResult> {
    const c = String(code || '').trim().toUpperCase();
    if (!c || c.length < 8) throw new BadRequestException('Código de rastreio inválido');

    const erros: string[] = [];

    // 1) Correios (contrato próprio)
    if (TrackingService.ehCodigoValido(c)) {
      try {
        const r: any = await this.correios.rastrear(c);
        const eventos = r?.eventos ?? [];
        if (r?.ok && eventos.length) {
          const res = this.montar(c, carrier, 'correios', {
            eventos,
            servico: r?.objeto?.tipoPostal?.categoria ?? null,
            servicoDesc: r?.objeto?.tipoPostal?.descricao ?? null,
            peso: r?.objeto?.pesoObjeto ?? r?.objeto?.peso ?? null,
            previsao: r?.objeto?.dtPrevista ?? null,
          });
          await this.salvarCache(res);
          return res;
        }
        // "SRO-009: objeto não pertence ao contrato" cai aqui — é o normal das
        // etiquetas do Mais Envios, não é erro.
        if (r?.erro) erros.push(`correios: ${r.erro}`);
      } catch (e: any) {
        erros.push(`correios: ${e?.message || e}`);
      }
    }

    // 2) Mais Envios (a maioria das etiquetas da casa)
    try {
      const r: any = await this.maisEnvios.rastrear(c);
      const eventos = r?.data?.eventos ?? [];
      if (r?.ok && eventos.length) {
        // O payload do Mais Envios varia por etiqueta: peso e previsão vêm em
        // umas e faltam em outras. Campo ausente vira null e simplesmente não
        // aparece na tela — nada aqui inventa número.
        const res = this.montar(c, carrier, 'maisenvios', {
          eventos,
          servico: r?.data?.servicoNome || r?.data?.categoria || null,
          servicoDesc: r?.data?.servicoDescricao || r?.data?.descricao || null,
          peso: r?.data?.weight ?? r?.data?.peso ?? null,
          previsao: r?.data?.deliveryForecast ?? r?.data?.previsaoEntrega ?? null,
        });
        await this.salvarCache(res);
        return res;
      }
    } catch (e: any) {
      erros.push(`maisenvios: ${e?.message || e}`);
    }

    // 3) LinkeTrack — só se algum dia o token existir.
    if (this.token) {
      const linke = await this.viaLinketrack(c, carrier);
      if (linke.events.length) {
        await this.salvarCache(linke);
        return linke;
      }
      if (linke.error) erros.push(`linketrack: ${linke.error}`);
    }

    // Nenhum provedor tem evento: objeto novo (etiqueta emitida agora) ou
    // código errado. Sem `error` quando os provedores responderam — "ainda sem
    // movimento" é informação, não falha.
    return {
      code: c,
      carrier: carrier || 'correios',
      service: null,
      events: [],
      lastStatus: null,
      delivered: false,
      deliveredAt: null,
      estimatedAt: null,
      fetchedAt: new Date().toISOString(),
      provider: 'nenhum',
      ...(erros.length ? { error: erros.join(' · ') } : {}),
    };
  }

  /** Provedor legado — mantido porque não custa nada e o contrato não muda. */
  private async viaLinketrack(code: string, carrier?: string): Promise<TrackingResult> {
    const url = `https://api.linketrack.com/track/json?user=${encodeURIComponent(
      this.user,
    )}&token=${encodeURIComponent(this.token || '')}&codigo=${encodeURIComponent(code)}`;
    const vazio: TrackingResult = {
      code,
      carrier: carrier || 'correios',
      service: null,
      events: [],
      lastStatus: null,
      delivered: false,
      fetchedAt: new Date().toISOString(),
      provider: 'linketrack',
    };
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'flowops-lite/1.0' },
        // @ts-ignore — Node 20+ suporta AbortSignal.timeout
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ...vazio, error: `HTTP ${res.status}` };
      const data: any = await res.json();
      const events: TrackingEvent[] = (Array.isArray(data?.eventos) ? data.eventos : []).map((e: any) => ({
        date: String(e.data || ''),
        time: String(e.hora || ''),
        location: String(e.local || ''),
        description: String(e.status || e.descricao || ''),
        isDelivery: this.ehEntrega(String(e.status || '')),
      }));
      return {
        ...vazio,
        service: data?.servico ? String(data.servico) : null,
        events,
        lastStatus: data?.ultimo ? String(data.ultimo) : events[0]?.description ?? null,
        delivered: Boolean(data?.entregue) || events.some((e) => e.isDelivery),
      };
    } catch (e: any) {
      return { ...vazio, error: e?.message || 'falha de rede' };
    }
  }

  // ── Cache (rastreio_objetos) ───────────────────────────────────────────

  /**
   * Grava o resultado no cache.
   *
   * ⚠️ REGRA DA ESTREIA: se o objeto JÁ ESTAVA entregue na primeira vez que o
   * sistema olhou pra ele, marca `entregaNaEstreia`. É notícia velha — serve
   * pra tela, mas não pode disparar "seu pedido chegou", senão o primeiro
   * deploy manda aviso pra quem recebeu semana passada (eram 46 pedidos).
   */
  async salvarCache(r: TrackingResult): Promise<void> {
    try {
      const primeiro = r.events[0];
      const eventoEm = primeiro ? this.paraData(this.deBr(primeiro.date, primeiro.time)) : null;
      const existente = await (this.prisma as any).rastreioObjeto.findUnique({
        where: { codigo: r.code },
        select: { codigo: true },
      });
      const comum = {
        provedor: r.provider,
        servico: r.service,
        status: r.lastStatus,
        local: primeiro?.location || null,
        eventoEm,
        previsaoEm: r.estimatedAt ? new Date(r.estimatedAt) : null,
        entregue: r.delivered,
        entregueEm: r.deliveredAt ? new Date(r.deliveredAt) : null,
        erro: r.error ?? null,
        consultadoEm: new Date(),
      };
      await (this.prisma as any).rastreioObjeto.upsert({
        where: { codigo: r.code },
        create: { codigo: r.code, ...comum, entregaNaEstreia: r.delivered },
        update: comum,
      });
      if (!existente && r.delivered) {
        this.logger.log(`[rastreio] ${r.code} entrou no radar JÁ ENTREGUE — não dispara aviso`);
      }
    } catch (e: any) {
      // Cache é conveniência: falha aqui não pode derrubar a consulta.
      this.logger.warn(`[rastreio] falha ao gravar cache de ${r.code}: ${e?.message || e}`);
    }
  }

  /** "18/08/2026" + "15:26" → "2026-08-18T15:26:00" (o formato que `paraData` lê). */
  private deBr(date: string, time: string): string | null {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(date || '').trim());
    if (!m) return null;
    const [, dd, mm, yyyy] = m;
    const t = /^(\d{2}):(\d{2})/.exec(String(time || '').trim());
    return `${yyyy}-${mm}-${dd}T${t ? `${t[1]}:${t[2]}` : '12:00'}:00`;
  }

  /** O que as listas leem — sem tocar em API nenhuma. */
  async resumoDoCache(codigos: (string | null | undefined)[]): Promise<Map<string, RastreioResumo>> {
    const alvos = [
      ...new Set(
        (codigos || [])
          .map((c) => String(c || '').trim().toUpperCase())
          .filter((c) => TrackingService.ehCodigoValido(c)),
      ),
    ];
    const out = new Map<string, RastreioResumo>();
    if (!alvos.length) return out;
    const linhas: any[] = await (this.prisma as any).rastreioObjeto.findMany({
      where: { codigo: { in: alvos } },
      select: {
        codigo: true, status: true, local: true, eventoEm: true,
        previsaoEm: true, entregue: true, entregueEm: true, consultadoEm: true,
      },
    });
    for (const l of linhas) out.set(l.codigo, l as RastreioResumo);
    return out;
  }

  /**
   * Sincroniza uma lista de códigos: UMA chamada em lote no SRO e, só pros que
   * ele não conhece, uma consulta individual no Mais Envios. É o que o cron usa.
   *
   * Devolve os códigos cuja entrega é NOVIDADE — o gancho pra promover o pedido
   * a `delivered` e liberar o aviso pra cliente. Objeto que entra no radar já
   * entregue NÃO entra nessa lista (regra da estreia).
   */
  async sincronizarLote(codigos: string[]): Promise<{ consultados: number; entreguesAgora: string[] }> {
    const alvos = [
      ...new Set(
        (codigos || [])
          .map((c) => String(c || '').trim().toUpperCase())
          .filter((c) => TrackingService.ehCodigoValido(c)),
      ),
    ];
    if (!alvos.length) return { consultados: 0, entreguesAgora: [] };

    const antes = await this.resumoDoCache(alvos);
    const entreguesAgora: string[] = [];
    let consultados = 0;

    let doSro = new Map<string, any>();
    try {
      doSro = await this.correios.rastrearLote(alvos);
    } catch (e: any) {
      this.logger.warn(`[rastreio] lote do SRO falhou: ${e?.message || e}`);
    }

    for (const codigo of alvos) {
      let res: TrackingResult | null = null;
      const obj = doSro.get(codigo);
      if (obj?.eventos?.length) {
        res = this.montar(codigo, 'correios', 'correios', {
          eventos: obj.eventos,
          servico: obj?.tipoPostal?.categoria ?? null,
          servicoDesc: obj?.tipoPostal?.descricao ?? null,
          peso: obj?.pesoObjeto ?? obj?.peso ?? null,
          previsao: obj?.dtPrevista ?? null,
        });
      } else {
        // Não é do contrato (ou ainda sem movimento) → Mais Envios, 1 request.
        try {
          const r: any = await this.maisEnvios.rastrear(codigo);
          const eventos = r?.data?.eventos ?? [];
          if (r?.ok && eventos.length) {
            res = this.montar(codigo, 'correios', 'maisenvios', {
              eventos,
              servico: r?.data?.servicoNome || r?.data?.categoria || null,
              servicoDesc: r?.data?.servicoDescricao || r?.data?.descricao || null,
              peso: r?.data?.weight ?? r?.data?.peso ?? null,
              previsao: r?.data?.deliveryForecast ?? r?.data?.previsaoEntrega ?? null,
            });
          }
        } catch (e: any) {
          this.logger.warn(`[rastreio] ${codigo} no Mais Envios: ${e?.message || e}`);
        }
      }

      if (!res) {
        // Sem evento em provedor nenhum: carimba a passagem pra não ficar
        // sempre no topo da fila do cron.
        await this.marcarConsultado(codigo);
        continue;
      }
      consultados++;
      const jaEstavaEntregue = antes.get(codigo)?.entregue === true;
      await this.salvarCache(res);
      if (res.delivered && !jaEstavaEntregue && antes.has(codigo)) entreguesAgora.push(codigo);
    }

    return { consultados, entreguesAgora };
  }

  /** Objeto sem movimento: só carimba a passagem (mantém o dado velho). */
  private async marcarConsultado(codigo: string): Promise<void> {
    try {
      await (this.prisma as any).rastreioObjeto.upsert({
        where: { codigo },
        create: { codigo, provedor: 'nenhum', consultadoEm: new Date() },
        update: { consultadoEm: new Date() },
      });
    } catch {
      /* cache é conveniência */
    }
  }
}
