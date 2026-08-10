import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';

/**
 * VIGIA DO TOKEN DA META — porque o silêncio dela custou 3 meses.
 *
 * ── O QUE ACONTECEU (10/08/2026) ──
 *
 * O dono reparou que a grade do Instagram na home mostrava foto estática. O
 * diagnóstico: `META_PAGE_ACCESS_TOKEN` tinha expirado em **17/05/2026** —
 * quase três meses antes. OAuthException 190, subcode 463.
 *
 * Ninguém soube porque TODO caminho que usa a Meta trata falha como silêncio,
 * e por bons motivos: a home não pode quebrar por causa do Instagram, e a live
 * não pode parar de vender porque a DM falhou. O problema é que "não quebrar"
 * virou "não avisar" — e esse token não serve só pra vitrine: é o MESMO que a
 * live usa pra responder comentário e mandar DM. Ou seja, provavelmente a
 * automação da live estava muda desde maio.
 *
 * Degradar com elegância é certo. Degradar em segredo, não.
 *
 * ── POR QUE UM CHECK PRÓPRIO, E NÃO "OLHAR O LOG" ──
 *
 * O erro JÁ aparecia no log (`getRecentMedia falhou: ...`). Log que ninguém lê
 * é a mesma coisa que log que não existe. Aqui a informação vai atrás da
 * pessoa: push pros admins, com antecedência de uma semana pra dar tempo de
 * gerar outro sem apagar incêndio.
 *
 * ── DECISÕES ──
 *
 * · Uma vez por dia, 9h. Token não vence de surpresa no meio da tarde: ou tem
 *   data marcada, ou já venceu. Checar de hora em hora só gastaria cota da
 *   Graph API — a mesma cota da live.
 * · `debug_token` é a pergunta certa: devolve validade e data de expiração SEM
 *   depender de o feed ter post ou de a conta ter permissão de mídia. Token
 *   pode estar válido e o feed vazio por outro motivo; são diagnósticos
 *   diferentes e não podem se confundir.
 * · Avisa a partir de 7 dias antes. Gerar token de System User passa pelo
 *   Business Manager, que nem sempre é coisa de cinco minutos.
 * · Sem token configurado: NÃO avisa. É o estado normal de quem ainda não
 *   ligou a integração — alerta aí seria ruído diário eterno.
 * · Nunca lança. Um watchdog que derruba o boot é pior que o problema que ele
 *   vigia.
 */
@Injectable()
export class MetaTokenWatchdogService {
  private readonly logger = new Logger(MetaTokenWatchdogService.name);

  /** Começa a incomodar a esta distância do vencimento. */
  private static readonly AVISAR_DIAS_ANTES = 7;
  /** Onde fica o último resultado — alimenta a tela e evita alerta repetido. */
  private static readonly CHAVE = 'meta.token.status';

  constructor(
    private readonly cfg: ConfigService,
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /** 9h todo dia. */
  @Cron('0 0 9 * * *', { name: 'meta-token-watchdog' })
  async rodar() {
    try {
      const estado = await this.checar();
      if (!estado) return;
      await this.guardar(estado);
      if (estado.alertar) await this.avisar(estado);
    } catch (e: any) {
      this.logger.warn(`[meta-token] vigia falhou: ${e?.message || e}`);
    }
  }

  /** O status pra tela (e pro cron). `null` = integração não configurada. */
  async checar(): Promise<StatusToken | null> {
    const token = (this.cfg.get<string>('META_PAGE_ACCESS_TOKEN') || '').trim();
    if (!token) return null;

    const base = this.cfg.get<string>('META_GRAPH_BASE') || 'https://graph.facebook.com/v21.0';
    let dados: any;
    try {
      const resp = await firstValueFrom(
        this.http.get(`${base}/debug_token`, {
          params: { input_token: token, access_token: token },
          timeout: 10_000,
        }),
      );
      dados = resp.data?.data;
    } catch (err: any) {
      /**
       * O próprio `debug_token` recusar o token JÁ É a resposta: quando ele
       * expira, a Graph API responde 400 em vez de devolver `is_valid: false`.
       * Tratar isso como "falha ao consultar" esconderia exatamente o caso que
       * este vigia existe pra pegar.
       */
      const msg = err?.response?.data?.error?.message || err?.message || 'erro desconhecido';
      return {
        valido: false,
        expiraEm: null,
        diasRestantes: null,
        motivo: msg,
        alertar: true,
        verificadoEm: new Date().toISOString(),
      };
    }

    const valido = dados?.is_valid === true;
    // `expires_at: 0` é o token que NÃO expira (System User) — o que queremos.
    const expiraEm = dados?.expires_at ? new Date(dados.expires_at * 1000) : null;
    const diasRestantes = expiraEm
      ? Math.floor((expiraEm.getTime() - Date.now()) / 86_400_000)
      : null;

    return {
      valido,
      expiraEm: expiraEm?.toISOString() ?? null,
      diasRestantes,
      motivo: valido ? null : 'token inválido',
      alertar:
        !valido ||
        (diasRestantes !== null && diasRestantes <= MetaTokenWatchdogService.AVISAR_DIAS_ANTES),
      verificadoEm: new Date().toISOString(),
    };
  }

  private async avisar(estado: StatusToken) {
    const [titulo, corpo] = !estado.valido
      ? [
          'Instagram desconectado',
          `O token da Meta não vale mais${estado.motivo ? ` (${estado.motivo})` : ''}. A grade do site caiu pra foto estática e a live não responde comentário nem DM.`,
        ]
      : [
          'Token da Meta vencendo',
          `Faltam ${estado.diasRestantes} dia(s). Depois disso o Instagram da home e as respostas da live param — sem erro na tela.`,
        ];

    /**
     * `tag` fixa: o alerta se SUBSTITUI a cada dia em vez de empilhar sete
     * notificações iguais na tela de quem já entendeu o recado.
     */
    const ok = await this.push.sendToAdmins({
      title: titulo,
      body: corpo,
      tag: 'meta-token',
      requireInteraction: true,
      data: { url: '/retaguarda/integracoes' },
    });
    this.logger.warn(`[meta-token] ${titulo}: ${corpo} (push=${JSON.stringify(ok)})`);
  }

  private async guardar(estado: StatusToken) {
    await (this.prisma as any).appConfig.upsert({
      where: { key: MetaTokenWatchdogService.CHAVE },
      create: { key: MetaTokenWatchdogService.CHAVE, valueJson: JSON.stringify(estado) },
      update: { valueJson: JSON.stringify(estado) },
    });
  }

  /** Último resultado gravado — pra tela não precisar bater na Meta. */
  async ultimoStatus(): Promise<StatusToken | null> {
    const linha = await (this.prisma as any).appConfig.findUnique({
      where: { key: MetaTokenWatchdogService.CHAVE },
    });
    if (!linha?.valueJson) return null;
    try {
      return JSON.parse(linha.valueJson);
    } catch {
      return null;
    }
  }
}

export interface StatusToken {
  valido: boolean;
  /** ISO, ou null quando o token não expira (System User). */
  expiraEm: string | null;
  diasRestantes: number | null;
  motivo: string | null;
  alertar: boolean;
  verificadoEm: string;
}
