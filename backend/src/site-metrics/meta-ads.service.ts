import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * O GASTO DE ANÚNCIO, ESPELHADO NO POSTGRES.
 *
 * A tela de conversão sabia quanto ENTROU (pedido pago, com `utm_id`) e não
 * sabia quanto SAIU. Sem o gasto não existe ROAS, e sem ROAS a cascata
 * responde "quantas pessoas" quando a pergunta é "quanto isso me deu".
 *
 * ── POR QUE ESPELHAR EM VEZ DE CHAMAR NA HORA ──
 *
 * Mesmo princípio do espelho Wincred: API de terceiro no caminho de render é
 * tela que trava quando o terceiro treme. Aqui é pior que o Wincred — o token
 * expira sozinho (já aconteceu com o da Live) e o rate limit do Meta é por
 * app. O cron traz, o Postgres serve.
 *
 * ── A CHAVE É O ID DA CAMPANHA ──
 *
 * `campaign.id` ↔ `Order.utmId`. Nunca o nome: nome é renomeado, chega
 * codificado duas vezes na URL do Meta e às vezes vem como número no
 * `utm_campaign`. Consequência boa: o NOME que a tela mostra passa a vir
 * daqui, da API, então rótulo torto no UTM deixa de sujar o relatório.
 *
 * ── DESLIGADO SEM TOKEN, E EM SILÊNCIO ──
 *
 * Sem `META_ADS_TOKEN` o cron não roda e a tela mostra "gasto não
 * configurado" em vez de ROAS zerado. Zero é uma afirmação; ausência é outra
 * coisa, e confundir as duas foi o que já custou caro nesta mesma tela.
 */
@Injectable()
export class MetaAdsService {
  private readonly logger = new Logger(MetaAdsService.name);
  private readonly graph = 'https://graph.facebook.com/v19.0';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private token(): string | null {
    return this.config.get<string>('META_ADS_TOKEN')?.trim() || null;
  }

  /** Contas a coletar, separadas por vírgula. Sem `act_`. */
  private contas(): string[] {
    return (this.config.get<string>('META_ADS_CONTAS') || '')
      .split(',')
      .map((c) => c.trim().replace(/^act_/, ''))
      .filter(Boolean);
  }

  configurado(): boolean {
    return Boolean(this.token() && this.contas().length);
  }

  /**
   * Cron de hora em hora. Recolhe HOJE e os 6 dias anteriores: o Meta
   * reprocessa atribuição por vários dias, então o gasto de ontem ainda muda
   * amanhã — recoletar é mais barato que conviver com número velho.
   *
   * `WINCRED_MIRROR_CRON_ENABLED` não vale aqui de propósito: são espelhos
   * diferentes, e amarrar um no outro faria desligar o Wincred apagar o ROAS.
   */
  @Cron('7 * * * *')
  async cronColeta(): Promise<void> {
    if (!this.configurado()) return;
    try {
      const n = await this.coletar(7);
      this.logger.log(`gasto de anúncio atualizado: ${n} linha(s)`);
    } catch (err) {
      // NUNCA lança: relatório sem gasto é pior que relatório, mas derrubar o
      // processo por causa de métrica é inaceitável.
      this.logger.error(`falha ao coletar gasto do Meta: ${String(err)}`);
    }
  }

  /** Puxa `dias` dias (contando hoje) de todas as contas configuradas. */
  async coletar(dias = 7): Promise<number> {
    const token = this.token();
    if (!token) return 0;

    const desde = this.diaSP(-Math.max(0, dias - 1));
    const ate = this.diaSP(0);
    let gravadas = 0;

    for (const conta of this.contas()) {
      const linhas = await this.buscarConta(conta, desde, ate, token);
      for (const l of linhas) {
        await (this.prisma as any).metaAdsGastoDia.upsert({
          where: {
            contaId_campanhaId_dia: { contaId: conta, campanhaId: l.campanhaId, dia: l.dia },
          },
          create: { contaId: conta, ...l },
          update: {
            campanhaNome: l.campanhaNome,
            gasto: l.gasto,
            impressoes: l.impressoes,
            cliques: l.cliques,
            chegadas: l.chegadas,
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

  private async buscarConta(
    conta: string,
    desde: string,
    ate: string,
    token: string,
  ): Promise<Array<{
    campanhaId: string; campanhaNome: string | null; dia: Date;
    gasto: number; impressoes: number; cliques: number; chegadas: number;
  }>> {
    const params = new URLSearchParams({
      level: 'campaign',
      // `time_increment=1` devolve UMA linha por campanha POR DIA — sem isso
      // vem o período somado e não dá pra cruzar com o filtro De/Até da tela.
      time_increment: '1',
      time_range: JSON.stringify({ since: desde, until: ate }),
      fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions',
      limit: '500',
      access_token: token,
    });

    const url = `${this.graph}/act_${conta}/insights?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const corpo = await res.text().catch(() => '');
      throw new Error(`Meta ${res.status} na conta ${conta}: ${corpo.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: any[] };

    return (json.data || []).map((d) => ({
      campanhaId: String(d.campaign_id),
      campanhaNome: d.campaign_name ? String(d.campaign_name).slice(0, 200) : null,
      // `date_start` vem 'YYYY-MM-DD'; `new Date()` disso é meia-noite UTC, que
      // é o que a coluna `@db.Date` guarda. Nada de fuso aqui — o dia já foi
      // recortado pelo Meta no fuso da CONTA.
      dia: new Date(`${d.date_start}T00:00:00.000Z`),
      gasto: Number(d.spend) || 0,
      impressoes: Number(d.impressions) || 0,
      cliques: Number(d.clicks) || 0,
      chegadas: this.acao(d.actions, 'landing_page_view'),
    }));
  }

  /** Lê um tipo de ação do array `actions` do insights. */
  private acao(actions: any, tipo: string): number {
    if (!Array.isArray(actions)) return 0;
    const hit = actions.find((a) => a?.action_type === tipo);
    return Number(hit?.value) || 0;
  }
}
