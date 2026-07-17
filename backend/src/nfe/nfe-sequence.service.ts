import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Numeração da NF-e (modelo 55) — contador próprio por loja+modelo+série,
 * SEPARADO do NFC-e (que fica em NfceConfig.numeroAtual, modelo 65 série 1).
 *
 * `proximo` guarda o PRÓXIMO número livre. O consumo é atômico (UPDATE ...
 * increment no banco), então dois emissores concorrentes nunca pegam o mesmo
 * número. Retorna o número que deve ser USADO agora.
 */
@Injectable()
export class NfeSequenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reserva e devolve o próximo número da série. `start` é usado só na 1ª vez
   * (quando a linha ainda não existe) — ex.: começar em 1 numa série nova.
   */
  async next(
    storeCode: string,
    serie: string,
    opts: { modelo?: string; start?: number } = {},
  ): Promise<number> {
    const modelo = opts.modelo || '55';
    const start = Math.max(1, opts.start ?? 1);
    const where = { storeCode_modelo_serie: { storeCode, modelo, serie } };

    // Garante a linha (não incrementa se já existe).
    await this.prisma.nfeSequence.upsert({
      where,
      create: { storeCode, modelo, serie, proximo: start },
      update: {},
    });

    // Incremento atômico: pega o próximo e avança em uma única operação.
    const updated = await this.prisma.nfeSequence.update({
      where,
      data: { proximo: { increment: 1 } },
      select: { proximo: true },
    });
    return updated.proximo - 1;
  }

  /** Status da numeração de uma loja (pra tela de config). */
  async status(storeCode: string, modelo = '55') {
    return this.prisma.nfeSequence.findMany({
      where: { storeCode, modelo },
      select: { serie: true, proximo: true, updatedAt: true },
      orderBy: { serie: 'asc' },
    });
  }

  /** Define/ajusta o próximo número de uma série (config inicial). */
  async setProximo(storeCode: string, serie: string, proximo: number, modelo = '55') {
    const where = { storeCode_modelo_serie: { storeCode, modelo, serie } };
    return this.prisma.nfeSequence.upsert({
      where,
      create: { storeCode, modelo, serie, proximo: Math.max(1, proximo) },
      update: { proximo: Math.max(1, proximo) },
    });
  }
}
