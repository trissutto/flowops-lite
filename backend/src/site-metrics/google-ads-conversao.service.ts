import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleAdsService } from './google-ads.service';

/**
 * A VENDA VOLTA PRO GOOGLE PELO SERVIDOR — sem GA4 no meio.
 *
 * ── POR QUE ISTO PRECISOU EXISTIR ──
 *
 * Em 19/08/2026, às 09:00, a conta de e-commerce parou de registrar conversão.
 * As DUAS ações morreram no mesmo minuto: a `Compra [OK]`, que era disparada
 * pelo Tag Manager do WordPress (e o WordPress morreu quando o site novo
 * assumiu `lurds.com.br`), e o import `[GA4] (web) purchase`, que é a ação
 * PRINCIPAL da conta. Resultado: três dias de campanha em ROAS desejado
 * otimizando às cegas, com a entrega do Shopping caindo de 487 para 127
 * cliques por dia — o robô não corta o gasto quando perde o sinal, corta a
 * entrega.
 *
 * A medição inteira dependia de uma corrente de três elos (site → GA4 → Ads)
 * em que ninguém avisa quando um elo arrebenta. Isto aqui é o caminho curto.
 *
 * ── POR QUE NÃO DÁ PRA FAZER COM TAG NO NAVEGADOR ──
 *
 * `purchase` é `SERVER_ONLY_EVENTS` no site, e por dois bons motivos: evento de
 * compra disparado pelo navegador é forjável (há teste cobrindo isso), e o PIX
 * é pago horas depois, quando não existe mais navegador aberto. Logo a
 * conversão TEM que sair do servidor — e o jeito de o servidor falar conversão
 * com o Google é o `uploadClickConversions`, casando pelo `gclid`.
 *
 * ── O QUE TORNA ISTO SEGURO DE RODAR ──
 *
 * · `orderId` vai em toda conversão: o Google deduplica por ele.
 * · `adsConversaoEnviadaEm` carimba o pedido: a garantia é NOSSA, não da rede
 *   do outro (mesma lição do outbox do PDV, que não confia no Giga).
 * · `partialFailure: true`: uma linha ruim não derruba o lote inteiro, e só os
 *   índices que voltaram OK são carimbados — o resto tenta de novo no ciclo
 *   seguinte.
 * · Sem credencial, o cron não roda. Sem `GOOGLE_ADS_CONVERSAO_ACTION_ID`
 *   também não: subir conversão pra ação errada suja a conta de um jeito que
 *   não tem desfazer.
 */
@Injectable()
export class GoogleAdsConversaoService {
  private readonly logger = new Logger(GoogleAdsConversaoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ads: GoogleAdsService,
  ) {}

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
   * O id da AÇÃO de conversão (não o rótulo do snippet). Na conta
   * 892-523-1246 a ação `Compra [OK]` tem "Código do tipo de conversão"
   * **6807548872** — é esse número que entra aqui.
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
   * A cada 10 minutos. Não precisa ser mais rápido: o Google leva horas pra
   * refletir a conversão no relatório de qualquer jeito, e o lance dele
   * reaprende em dias, não em minutos.
   */
  @Cron('*/10 * * * *')
  async cronEnviar(): Promise<void> {
    if (!this.configurado()) return;
    try {
      const n = await this.enviarPendentes();
      if (n > 0) this.logger.log(`conversões enviadas ao Google Ads: ${n}`);
    } catch (err) {
      // Nunca lança: métrica não derruba processo.
      this.logger.error(`falha ao enviar conversão ao Google: ${String(err)}`);
    }
  }

  /**
   * Sobe as vendas pagas que ainda não foram contadas pelo Google.
   *
   * A janela de 60 dias não é estética: o Google recusa conversão cujo clique
   * caiu fora da janela da ação (30 dias na `Compra [OK]`), e ficar
   * reapresentando pedido velho a cada 10 minutos geraria erro pra sempre.
   */
  async enviarPendentes(limite = 200): Promise<number> {
    if (!this.configurado()) return 0;

    const desde = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const pedidos = await (this.prisma as any).order.findMany({
      where: {
        source: 'ecommerce',
        status: { in: ['paid', 'separating', 'shipped', 'delivered', 'completed'] },
        gclid: { not: null },
        adsConversaoEnviadaEm: null,
        createdAt: { gte: desde },
      },
      select: {
        id: true,
        wcOrderNumber: true,
        gclid: true,
        totalAmount: true,
        paidAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(limite, 2000),
    });
    if (!pedidos.length) return 0;

    const conta = this.conta()!;
    const acao = `customers/${conta}/conversionActions/${this.acaoId()}`;

    const conversoes = pedidos.map((p: any) => ({
      gclid: p.gclid,
      conversionAction: acao,
      // A hora da CONVERSÃO é a do pagamento, não a do pedido: o PIX pago no
      // dia seguinte pertence ao dia seguinte. Sem `paidAt` (pedido antigo),
      // o `createdAt` é a melhor aproximação que existe.
      conversionDateTime: this.momento(p.paidAt ?? p.createdAt),
      conversionValue: Number(p.totalAmount) || 0,
      currencyCode: 'BRL',
      // A chave de deduplicação do lado do Google.
      orderId: p.wcOrderNumber ?? p.id,
    }));

    const resposta = await this.ads.requisitar(`customers/${conta}:uploadClickConversions`, {
      conversions: conversoes,
      partialFailure: true,
    });

    // `results` vem com UMA entrada por conversão enviada, na mesma ordem. A
    // que falhou volta como objeto VAZIO — e é por isso que o carimbo é por
    // índice: marcar o lote inteiro perderia em silêncio as que o Google
    // recusou, que são justamente as que precisam de outra tentativa.
    const resultados: any[] = Array.isArray(resposta?.results) ? resposta.results : [];
    const enviados = pedidos.filter((_: any, i: number) => {
      const r = resultados[i];
      return Boolean(r && (r.orderId || r.gclidDateTimePair || r.conversionAction));
    });

    if (enviados.length) {
      await (this.prisma as any).order.updateMany({
        where: { id: { in: enviados.map((p: any) => p.id) } },
        data: { adsConversaoEnviadaEm: new Date() },
      });
    }

    const recusadas = pedidos.length - enviados.length;
    if (recusadas > 0) {
      // O detalhe do `partialFailureError` é o que diz SE vale tentar de novo
      // (rede) ou se é recusa definitiva (clique fora da janela). Sem ele no
      // log, um erro permanente vira retry eterno de 10 em 10 minutos.
      this.logger.warn(
        `${recusadas} conversão(ões) recusada(s) pelo Google: ` +
          `${JSON.stringify(resposta?.partialFailureError ?? {}).slice(0, 500)}`,
      );
    }
    return enviados.length;
  }

  /**
   * 'yyyy-MM-dd HH:mm:ss+/-HH:mm' — o formato que a API exige, com fuso
   * EXPLÍCITO. Mandar sem o deslocamento faz o Google assumir o fuso da conta,
   * e uma venda das 23h vira do dia seguinte.
   */
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
    // 'sv-SE' já entrega 'YYYY-MM-DD HH:mm:ss' — é o único locale que sai no
    // formato que a API quer sem remontar string na mão.
    const local = new Intl.DateTimeFormat('sv-SE', opcoes).format(d).replace('T', ' ');

    // O deslocamento é PERGUNTADO, não chumbado. Hoje o Brasil não tem horário
    // de verão (acabou em 2019) e isto devolve sempre -03:00 — mas se voltar,
    // um `-03:00` fixo passaria a mandar toda venda de verão uma hora errada,
    // silenciosamente, e ninguém olha carimbo de conversão.
    const nome = new Intl.DateTimeFormat('en-US', { ...opcoes, timeZoneName: 'longOffset' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value; // ex.: 'GMT-03:00'
    const offset = /GMT([+-]\d{2}:\d{2})/.exec(nome ?? '')?.[1] ?? '-03:00';

    return `${local}${offset}`;
  }
}
