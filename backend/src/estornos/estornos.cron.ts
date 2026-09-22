import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EstornosService } from './estornos.service';

/**
 * QUEM FECHA O "EM PROCESSAMENTO" (22/09/2026).
 *
 * O PagBank **não avisa** a conclusão de um estorno: não existe webhook de
 * refund confirmado. Se ninguém perguntar, o estorno que voltou "em
 * processamento" fica assim pra sempre na tela — e a matriz não tem como saber
 * se o dinheiro saiu, que é exatamente o buraco que esta função existe pra
 * fechar (mesma doença da fila do outbox: falhou e ninguém é avisado).
 *
 * De 10 em 10 minutos, os mais esquecidos primeiro (`consultadoEm` mais
 * antigo), 30 por ciclo. Passados 30 dias o estorno sai do radar: o gateway
 * não muda mais nada, e quem ficou aberto até ali é caso pra olho humano.
 *
 * `ESTORNOS_SYNC=0` desliga (a tela continua com o botão "Atualizar status").
 */
@Injectable()
export class EstornosCron {
  private readonly logger = new Logger(EstornosCron.name);
  private rodando = false;

  constructor(private readonly estornos: EstornosService) {}

  private ligado(): boolean {
    return String(process.env.ESTORNOS_SYNC ?? '').trim() !== '0';
  }

  @Cron('*/10 * * * *', { name: 'estornos-pendentes', timeZone: 'America/Sao_Paulo' })
  async conferirPendentes() {
    if (!this.ligado()) return;
    // Guard de overlap: ciclo que demora não pode empilhar em cima do próximo
    // (foi assim que o polling do PagBank derrubou a live de 01/07).
    if (this.rodando) return;
    this.rodando = true;
    try {
      const r = await this.estornos.consultarPendentes(30);
      if (r.olhados) {
        this.logger.log(`[estornos] ${r.olhados} pendente(s) conferido(s), ${r.mudaram} mudaram de status`);
      }
    } catch (e: any) {
      this.logger.warn(`[estornos] ciclo de pendentes falhou: ${e?.message || e}`);
    } finally {
      this.rodando = false;
    }
  }
}
