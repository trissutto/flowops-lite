import { Injectable, Logger } from '@nestjs/common';
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
 */
@Injectable()
export class PendenciaExpiryCron {
  private readonly logger = new Logger(PendenciaExpiryCron.name);
  private rodando = false;

  constructor(private readonly promessa: PromessaEstoqueService) {}

  /** Dias até expirar. Default 7 (decisão do dono). `0` desliga. */
  private get dias(): number {
    const raw = String(process.env.TRANSFER_PENDING_EXPIRY_DIAS ?? '').trim();
    if (!raw) return 7;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7;
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
