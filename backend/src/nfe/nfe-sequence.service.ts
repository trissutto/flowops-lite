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
    opts: { modelo?: string; start?: number; legacyKey?: string } = {},
  ): Promise<number> {
    const modelo = opts.modelo || '55';
    let start = Math.max(1, opts.start ?? 1);
    const where = { storeCode_modelo_serie: { storeCode, modelo, serie } };

    // MIGRAÇÃO 29/07 (numeração passou a ser POR CNPJ): na 1ª emissão da
    // chave nova, herda o contador da linha LEGADA da loja (legacyKey) —
    // senão a filial recomeçaria do 1 e dependeria do pula-pula de 539.
    const existente = await this.prisma.nfeSequence.findUnique({ where });
    if (!existente && opts.legacyKey && opts.legacyKey !== storeCode) {
      const legado = await this.prisma.nfeSequence.findUnique({
        where: { storeCode_modelo_serie: { storeCode: opts.legacyKey, modelo, serie } },
      });
      if (legado) start = Math.max(start, legado.proximo);
    }

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

  /** A CHAVE da numeração é o CNPJ EMITENTE (dono 29/07: T.O. e LURDS têm
   *  sequências próprias — por loja misturava as matrizes de Itanhaém).
   *  Aceita código de loja (resolve o CNPJ da NF-e na config) ou o próprio
   *  CNPJ com 14 dígitos. */
  private async chaveDe(storeCodeOuCnpj: string): Promise<string> {
    const d = String(storeCodeOuCnpj || '').replace(/\D/g, '');
    if (d.length === 14) return d;
    const cfg: any = await this.prisma.nfceConfig.findUnique({ where: { storeCode: storeCodeOuCnpj } });
    const key = String(cfg?.nfeCnpj || cfg?.cnpj || '').replace(/\D/g, '');
    return key.length === 14 ? key : storeCodeOuCnpj;
  }

  /** Status da numeração de uma loja/CNPJ (pra tela de config). */
  async status(storeCode: string, modelo = '55') {
    const key = await this.chaveDe(storeCode);
    const rows = await this.prisma.nfeSequence.findMany({
      where: { storeCode: key, modelo },
      select: { serie: true, proximo: true, updatedAt: true },
      orderBy: { serie: 'asc' },
    });
    if (rows.length || key === storeCode) return rows;
    // legado: linha antiga chaveada pelo código da loja
    return this.prisma.nfeSequence.findMany({
      where: { storeCode, modelo },
      select: { serie: true, proximo: true, updatedAt: true },
      orderBy: { serie: 'asc' },
    });
  }

  /** Numeração de TODAS as lojas (série 1) + nome + CNPJ da NF-e, pra tela de
   *  gerência. Mostra o próximo número que o Flow usará em cada loja. */
  async listAll(modelo = '55') {
    const [seqs, stores, cfgs] = await Promise.all([
      this.prisma.nfeSequence.findMany({ where: { modelo }, select: { storeCode: true, serie: true, proximo: true, updatedAt: true } }),
      this.prisma.store.findMany({ where: { active: true }, select: { code: true, name: true }, orderBy: { code: 'asc' } }),
      this.prisma.nfceConfig.findMany({ select: { storeCode: true, cnpj: true, nfeCnpj: true } }),
    ]);
    const seqByStore = new Map(seqs.filter((s) => s.serie === '1').map((s) => [s.storeCode, s]));
    const cfgByStore = new Map(cfgs.map((c) => [c.storeCode, c]));
    return stores.map((st) => {
      const cfg: any = cfgByStore.get(st.code);
      const cnpj = (cfg?.nfeCnpj || cfg?.cnpj || '').replace(/\D/g, '');
      // Chave nova = CNPJ emitente; cai pra linha legada (código da loja)
      const seq = (cnpj && seqByStore.get(cnpj)) || seqByStore.get(st.code);
      return {
        storeCode: st.code,
        storeName: st.name,
        cnpj: cnpj || null,
        serie: '1',
        proximo: seq?.proximo ?? null, // null = nunca emitiu pelo Flow
        updatedAt: seq?.updatedAt ?? null,
      };
    });
  }

  /** Define/ajusta o próximo número de uma série (config inicial). */
  async setProximo(storeCode: string, serie: string, proximo: number, modelo = '55') {
    const key = await this.chaveDe(storeCode);
    const where = { storeCode_modelo_serie: { storeCode: key, modelo, serie } };
    return this.prisma.nfeSequence.upsert({
      where,
      create: { storeCode: key, modelo, serie, proximo: Math.max(1, proximo) },
      update: { proximo: Math.max(1, proximo) },
    });
  }
}
