import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PromessaEstoqueService } from './promessa-estoque.service';

/**
 * PENDÊNCIA DE TRANSFERÊNCIA NÃO VALE PRA SEMPRE (24/08 — dono: 7 dias).
 *
 * Ordem pedida e nunca enviada segura a peça no desconto da Grade por Loja
 * indefinidamente — foi assim que Itanhaém apareceu com `-2` em peça que ela
 * não tinha. Pior: as de `tipo=TRANSFERENCIA` nem aparecem na fila da loja
 * (`listPendingForStore` filtra REALINHAMENTO), então ninguém ia cancelar na
 * mão o que não vê.
 *
 * Roda 1x/dia às 4h35 — fora do horário de loja e longe do full do espelho
 * (3h). Só toca pendência SEM CAIXA: peça já bipada numa caixa aberta é
 * assunto do "Fechar e enviar".
 *
 * `TRANSFER_PENDING_EXPIRY_DIAS` muda a janela; `0` desliga a varredura.
 *
 * ── ÓRFÃS DE TRANSFERÊNCIA (23/11/2026) ──
 * Linha `tipo=TRANSFERENCIA` `pending` SEM caixa é bipe que não completou
 * (ver `common/promessa-transferencia.ts`): invisível em toda tela e, até o
 * conserto, contada pela trava do eco do leitor como "peça já pedida" — em
 * 23/11 Itanhaém acumulou 42 em 5 minutos e não conseguia bipar mais nada
 * pra Praia Grande. Esperar 7 dias por ela é inaceitável: a varredura roda
 * no boot (os restos do dia do incidente somem no deploy) e de hora em hora,
 * cancelando o que tem mais de `TRANSFER_ORFA_SWEEP_MIN` minutos (padrão 10;
 * `0` desliga). Hoje o bipe grava a peça já dentro da caixa, então o estado
 * não nasce mais — a varredura é a rede de segurança.
 */
@Injectable()
export class PendenciaExpiryCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(PendenciaExpiryCron.name);
  private rodando = false;
  private varrendoOrfas = false;

  constructor(private readonly promessa: PromessaEstoqueService) {}

  /** Dias até expirar. Default 7 (decisão do dono). `0` desliga. */
  private get dias(): number {
    const raw = String(process.env.TRANSFER_PENDING_EXPIRY_DIAS ?? '').trim();
    if (!raw) return 7;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7;
  }

  /** Idade mínima (min) da órfã de transferência pra ser cancelada. `0` desliga. */
  private get orfaMinutos(): number {
    const raw = String(process.env.TRANSFER_ORFA_SWEEP_MIN ?? '').trim();
    if (!raw) return 10;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
  }

  onApplicationBootstrap() {
    // 60s depois do boot: deixa o Prisma conectar e o resto subir primeiro.
    const t = setTimeout(() => void this.varrerOrfas(), 60_000);
    (t as any).unref?.();
  }

  @Cron('23 * * * *', { name: 'orfa-transferencia-sweep' })
  async varrerOrfas() {
    const minutos = this.orfaMinutos;
    if (minutos <= 0) return; // desligado por env
    if (this.varrendoOrfas) return; // guard de overlap
    this.varrendoOrfas = true;
    try {
      const r = await this.promessa.cancelarOrfasDeTransferencia(minutos);
      if (r.canceladas > 0) {
        this.logger.log(
          `[cron] ${r.canceladas} bipe(s) de transferência sem caixa cancelado(s) · ` +
            r.porLoja.map((p) => `${p.loja}:${p.n}`).join(' '),
        );
      }
    } catch (e) {
      this.logger.error(`[cron] varredura de órfãs de transferência FALHOU: ${(e as Error).message}`);
    } finally {
      this.varrendoOrfas = false;
    }
  }

  @Cron('35 4 * * *', { name: 'pendencia-transferencia-expiry' })
  async run() {
    const dias = this.dias;
    if (dias <= 0) return; // desligado por env
    if (this.rodando) return; // guard de overlap
    this.rodando = true;
    try {
      const r = await this.promessa.expirarPendenciasVelhas(dias);
      if (r.canceladas > 0) {
        this.logger.log(
          `[cron] ${r.canceladas} pendência(s) com mais de ${dias} dias expirada(s) · ` +
            r.porLoja.map((p) => `${p.loja}:${p.n}`).join(' '),
        );
      }
    } catch (e) {
      this.logger.error(`[cron] expiração de pendência FALHOU: ${(e as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }
}
