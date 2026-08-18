import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CorreiosService } from '../correios/correios.service';
import { MaisEnviosService } from '../mais-envios/mais-envios.service';

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

  /** "CAMPINAS/SP" a partir da unidade do evento (o formato varia por provedor). */
  private local(ev: any): string {
    const end = ev?.unidade?.endereco ?? {};
    const cidade = String(end.cidade || '').trim();
    const uf = String(end.uf || '').trim();
    if (cidade && uf) return `${cidade}/${uf}`;
    if (cidade) return cidade;
    const nome = String(ev?.unidade?.nome || ev?.unidade?.tipo || '').trim();
    return uf && nome ? `${nome}/${uf}` : nome || uf;
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
    dados: { eventos: any[]; servico?: string | null; previsao?: string | null },
  ): TrackingResult {
    const crus = Array.isArray(dados.eventos) ? dados.eventos : [];
    const events = this.normalizarEventos(crus);
    // A entrega é o evento mais recente que fala em "entregue": pega a data do
    // evento CRU correspondente pra não reconstruir a partir do texto.
    const entregaCrua = crus
      .filter((ev) => this.ehEntrega(String(ev?.descricao || ev?.status || '')))
      .sort((a, b) => (this.paraData(b?.dtHrCriado)?.getTime() ?? 0) - (this.paraData(a?.dtHrCriado)?.getTime() ?? 0))[0];
    return {
      code,
      carrier: carrier || 'correios',
      service: dados.servico ?? null,
      events,
      lastStatus: events[0]?.description ?? null,
      delivered: !!entregaCrua,
      deliveredAt: entregaCrua ? this.paraData(entregaCrua.dtHrCriado)?.toISOString() ?? null : null,
      estimatedAt: dados.previsao ? this.paraData(dados.previsao)?.toISOString() ?? null : null,
      fetchedAt: new Date().toISOString(),
      provider,
    };
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
        const res = this.montar(c, carrier, 'maisenvios', {
          eventos,
          servico: r?.data?.servicoNome || r?.data?.categoria || null,
          previsao: null,
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
              previsao: null,
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
