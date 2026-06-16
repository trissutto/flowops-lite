import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PontoService — registro e consulta de ponto eletrônico (REP-A).
 *
 * Funcionalidades:
 *  - enrollFace: salva descriptors faciais da funcionária (3 ângulos)
 *  - listDescriptorsForStore: retorna descriptors das vendedoras ativas da loja
 *    (usado pelo PDV pra fazer match local sem expor descriptors de outras lojas)
 *  - registrar: grava uma batida. Timestamp é do SERVIDOR (not client).
 *  - getEspelho: monta espelho de ponto mensal (dias × horários × horas)
 *  - justificar: admin corrige/justifica falta ou esquecimento
 *  - listLast: lista as últimas N batidas de uma vendedora
 */
@Injectable()
export class PontoService {
  private readonly logger = new Logger(PontoService.name);
  private r2ClientCache: S3Client | null = null;

  static readonly TIPOS_VALIDOS = [
    'entrada',
    'saida_almoco',
    'volta_almoco',
    'saida',
  ];

  static readonly SOURCES_VALIDOS = ['face_pdv', 'pwa_selfie', 'manual_admin'];

  /** Janela mínima entre duas batidas IGUAIS (evita duplo-clique). */
  static readonly DEBOUNCE_MIN = 2; // 2 minutos

  constructor(private readonly prisma: PrismaService) {}

  // ── R2 helpers (mesmo padrão do imobiliário/seller-documents) ────
  private getR2Client(): S3Client {
    if (this.r2ClientCache) return this.r2ClientCache;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secret = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKey || !secret) {
      throw new BadRequestException('R2 não configurado.');
    }
    this.r2ClientCache = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: accessKey, secretAccessKey: secret },
    });
    return this.r2ClientCache;
  }

  private async uploadSnapshot(
    sellerId: string,
    base64: string,
    prefix: string,
  ): Promise<string | null> {
    if (!base64) return null;
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!bucket || !publicUrl) return null;

    // base64 pode vir como "data:image/jpeg;base64,XXX" — strip prefixo
    const clean = base64.includes(',') ? base64.split(',')[1] : base64;
    const buffer = Buffer.from(clean, 'base64');
    const key = `rh/ponto/${sellerId}/${prefix}-${Date.now()}.jpg`;

    try {
      const client = this.getR2Client();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: 'image/jpeg',
        }),
      );
      return `${publicUrl.replace(/\/$/, '')}/${key}`;
    } catch (e: any) {
      this.logger.warn(`[ponto] upload snapshot falhou: ${e?.message}`);
      return null;
    }
  }

  // ── CADASTRO DE ROSTO ─────────────────────────────────────────────

  /**
   * Salva os descriptors faciais da funcionária.
   * descriptors: array de Float32Array serializadas (cada uma 128 nums).
   * snapshotBase64: foto de referência (opcional, vai pro R2 pra audit).
   */
  async enrollFace(
    sellerId: string,
    descriptors: number[][],
    snapshotBase64?: string,
  ) {
    if (!Array.isArray(descriptors) || descriptors.length === 0) {
      throw new BadRequestException('descriptors obrigatórios');
    }
    // Cada descriptor deve ter 128 dimensões (padrão face-api.js)
    for (const d of descriptors) {
      if (!Array.isArray(d) || d.length !== 128) {
        throw new BadRequestException(
          'cada descriptor deve ter exatamente 128 valores',
        );
      }
    }

    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: sellerId },
      select: { id: true, name: true },
    });
    if (!seller) throw new NotFoundException('Funcionária não encontrada');

    const snapshotUrl = snapshotBase64
      ? await this.uploadSnapshot(sellerId, snapshotBase64, 'enroll')
      : null;

    await (this.prisma as any).seller.update({
      where: { id: sellerId },
      data: {
        faceDescriptors: JSON.stringify(descriptors),
        faceEnrolledAt: new Date(),
        faceSnapshotUrl: snapshotUrl,
      },
    });

    this.logger.log(
      `[ponto] face enroll seller=${seller.name} (${descriptors.length} descriptors)`,
    );

    return { ok: true, count: descriptors.length, snapshotUrl };
  }

  /**
   * Retorna descriptors de TODAS as vendedoras ativas da loja.
   * Usado pelo PDV pra fazer matching local sem ir no servidor a cada frame.
   * Não retorna o snapshot (a foto referencia) — só ID + nome + descriptors.
   */
  async listDescriptorsForStore(storeId: string) {
    const sellers = await (this.prisma as any).seller.findMany({
      where: {
        active: true,
        faceDescriptors: { not: null },
        OR: [
          { responsibleStoreId: storeId },
          { storeCodeOrigin: { not: null } }, // fallback compat
        ],
      },
      select: {
        id: true,
        name: true,
        cargo: true,
        faceDescriptors: true,
      },
    });

    return sellers
      .map((s: any) => {
        let descriptors: number[][] = [];
        try {
          descriptors = JSON.parse(s.faceDescriptors) || [];
        } catch {
          descriptors = [];
        }
        return {
          id: s.id,
          name: s.name,
          cargo: s.cargo,
          descriptors,
        };
      })
      .filter((s: any) => s.descriptors.length > 0);
  }

  /** Remove o cadastro facial (vendedora pediu pra refazer ou foi desligada). */
  async clearFace(sellerId: string) {
    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: sellerId },
    });
    if (!seller) throw new NotFoundException('Funcionária não encontrada');

    await (this.prisma as any).seller.update({
      where: { id: sellerId },
      data: {
        faceDescriptors: null,
        faceEnrolledAt: null,
        faceSnapshotUrl: null,
      },
    });
    return { ok: true };
  }

  // ── REGISTRAR PONTO ───────────────────────────────────────────────

  async registrar(input: {
    sellerId: string;
    storeId: string;
    tipo: string;
    source: string;
    faceConfidence?: number;
    snapshotBase64?: string;
    lat?: number;
    lng?: number;
    ip?: string;
    observacoes?: string;
  }) {
    const tipo = (input.tipo || '').toLowerCase();
    if (!PontoService.TIPOS_VALIDOS.includes(tipo)) {
      throw new BadRequestException(
        `Tipo inválido. Use: ${PontoService.TIPOS_VALIDOS.join(', ')}`,
      );
    }
    const source = (input.source || 'face_pdv').toLowerCase();
    if (!PontoService.SOURCES_VALIDOS.includes(source)) {
      throw new BadRequestException(`source inválido`);
    }

    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: input.sellerId },
      select: { id: true, name: true, active: true },
    });
    if (!seller) throw new NotFoundException('Funcionária não encontrada');
    if (!seller.active) {
      throw new BadRequestException(`${seller.name} está DESLIGADA — não pode bater ponto`);
    }

    const store = await (this.prisma as any).store.findUnique({
      where: { id: input.storeId },
      select: { id: true, name: true },
    });
    if (!store) throw new NotFoundException('Loja não encontrada');

    // Debounce: já existe batida MESMA tipo nos últimos N minutos? rejeita
    const debounceFrom = new Date(Date.now() - PontoService.DEBOUNCE_MIN * 60_000);
    const recent = await (this.prisma as any).pontoRegistro.findFirst({
      where: {
        sellerId: input.sellerId,
        tipo,
        timestamp: { gte: debounceFrom },
      },
      orderBy: { timestamp: 'desc' },
    });
    if (recent) {
      throw new BadRequestException(
        `Ponto de "${tipo}" já registrado há menos de ${PontoService.DEBOUNCE_MIN} min`,
      );
    }

    // Sobe snapshot pro R2 (audit)
    const snapshotUrl = input.snapshotBase64
      ? await this.uploadSnapshot(input.sellerId, input.snapshotBase64, tipo)
      : null;

    const reg = await (this.prisma as any).pontoRegistro.create({
      data: {
        sellerId: input.sellerId,
        storeId: input.storeId,
        tipo,
        source,
        faceConfidence: input.faceConfidence ?? null,
        faceSnapshot: snapshotUrl,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        ip: input.ip ?? null,
        observacoes: input.observacoes ?? null,
      },
    });

    this.logger.log(
      `[ponto] ${seller.name} → ${tipo} @ ${store.name} (conf=${input.faceConfidence?.toFixed(2) ?? '-'})`,
    );

    return {
      ok: true,
      registro: reg,
      seller: { id: seller.id, name: seller.name },
    };
  }

  // ── ESPELHO DE PONTO ─────────────────────────────────────────────

  /** Lista últimas N batidas de uma vendedora (default: 20). */
  async listLast(sellerId: string, limit = 20) {
    return (this.prisma as any).pontoRegistro.findMany({
      where: { sellerId },
      orderBy: { timestamp: 'desc' },
      take: limit,
      include: { store: { select: { code: true, name: true } } },
    });
  }

  /**
   * Espelho mensal de uma vendedora.
   * Retorna array com 1 entry por dia do mês, com batidas + total horas + saldo.
   */
  async getEspelhoMensal(
    sellerId: string,
    ano: number,
    mes: number, // 1-12
  ) {
    const inicio = new Date(ano, mes - 1, 1, 0, 0, 0, 0);
    const fim = new Date(ano, mes, 0, 23, 59, 59, 999);

    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: sellerId },
      select: {
        id: true,
        name: true,
        horarioTrabalho: true,
        cargo: true,
      },
    });
    if (!seller) throw new NotFoundException('Funcionária não encontrada');

    const registros = await (this.prisma as any).pontoRegistro.findMany({
      where: {
        sellerId,
        timestamp: { gte: inicio, lte: fim },
      },
      orderBy: { timestamp: 'asc' },
    });

    // Parse horário esperado
    let horarioExpected: any[] = [];
    try {
      horarioExpected = seller.horarioTrabalho
        ? JSON.parse(seller.horarioTrabalho)
        : [];
    } catch {
      horarioExpected = [];
    }
    const DIAS_KEY = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];

    // Agrupa por dia
    const diasMap: Record<string, any[]> = {};
    for (const r of registros) {
      const dKey = r.timestamp.toISOString().slice(0, 10);
      if (!diasMap[dKey]) diasMap[dKey] = [];
      diasMap[dKey].push(r);
    }

    const dias: any[] = [];
    const lastDay = fim.getDate();
    let totalMinTrabalhado = 0;
    let totalMinPrevisto = 0;

    for (let d = 1; d <= lastDay; d++) {
      const dt = new Date(ano, mes - 1, d);
      const dKey = dt.toISOString().slice(0, 10);
      const diaSemana = DIAS_KEY[dt.getDay()];
      const expected = horarioExpected.find((h: any) => h.dia === diaSemana);
      const batidas = diasMap[dKey] || [];

      // Mapeia tipos pra horas
      const findTipo = (tipo: string) =>
        batidas.find((b: any) => b.tipo === tipo)?.timestamp;
      const entrada = findTipo('entrada');
      const saidaAlmoco = findTipo('saida_almoco');
      const voltaAlmoco = findTipo('volta_almoco');
      const saida = findTipo('saida');

      // Minutos trabalhados real
      let minTrabalhado = 0;
      if (entrada && saida) {
        minTrabalhado = (new Date(saida).getTime() - new Date(entrada).getTime()) / 60000;
        if (saidaAlmoco && voltaAlmoco) {
          minTrabalhado -=
            (new Date(voltaAlmoco).getTime() - new Date(saidaAlmoco).getTime()) / 60000;
        }
      }
      minTrabalhado = Math.max(0, Math.round(minTrabalhado));

      // Minutos previstos
      let minPrevisto = 0;
      let folga = false;
      if (expected) {
        if (expected.folga) {
          folga = true;
        } else {
          const toMin = (s: string) => {
            const [h, m] = (s || '0:0').split(':').map(Number);
            return (h || 0) * 60 + (m || 0);
          };
          minPrevisto = toMin(expected.fim) - toMin(expected.inicio);
          if (expected.almocoInicio && expected.almocoFim) {
            const almoco = toMin(expected.almocoFim) - toMin(expected.almocoInicio);
            if (almoco > 0) minPrevisto -= almoco;
          }
          minPrevisto = Math.max(0, minPrevisto);
        }
      }

      totalMinTrabalhado += minTrabalhado;
      totalMinPrevisto += minPrevisto;

      dias.push({
        data: dKey,
        diaSemana,
        folga,
        entrada: entrada ?? null,
        saidaAlmoco: saidaAlmoco ?? null,
        voltaAlmoco: voltaAlmoco ?? null,
        saida: saida ?? null,
        minTrabalhado,
        minPrevisto,
        saldoMin: minTrabalhado - minPrevisto,
        batidas: batidas.length,
        completo: !!entrada && !!saida && (folga ? true : true),
        justificado: batidas.some((b: any) => b.justificado),
      });
    }

    return {
      seller: { id: seller.id, name: seller.name, cargo: seller.cargo },
      periodo: { ano, mes, inicio, fim },
      dias,
      totais: {
        minTrabalhado: totalMinTrabalhado,
        minPrevisto: totalMinPrevisto,
        saldoMin: totalMinTrabalhado - totalMinPrevisto,
      },
    };
  }

  /** Espelho consolidado da loja inteira (1 vendedora por linha, sumarizado). */
  async getEspelhoStore(storeId: string, ano: number, mes: number) {
    const sellers = await (this.prisma as any).seller.findMany({
      where: { active: true, responsibleStoreId: storeId },
      select: { id: true, name: true },
    });

    const items: any[] = [];
    for (const s of sellers) {
      const esp = await this.getEspelhoMensal(s.id, ano, mes);
      items.push({
        sellerId: s.id,
        name: s.name,
        totais: esp.totais,
        diasTrabalhados: esp.dias.filter((d: any) => d.minTrabalhado > 0).length,
        diasFalta: esp.dias.filter(
          (d: any) => !d.folga && d.minPrevisto > 0 && d.minTrabalhado === 0,
        ).length,
      });
    }

    return { storeId, ano, mes, items };
  }

  // ── JUSTIFICATIVA / CORREÇÃO MANUAL ──────────────────────────────

  async justificar(
    registroId: string,
    justificativa: string,
    userId?: string,
  ) {
    const reg = await (this.prisma as any).pontoRegistro.findUnique({
      where: { id: registroId },
    });
    if (!reg) throw new NotFoundException('Registro não encontrado');

    return (this.prisma as any).pontoRegistro.update({
      where: { id: registroId },
      data: {
        justificado: true,
        justificativa,
        justificadoBy: userId || null,
        justificadoAt: new Date(),
      },
    });
  }

  /** Admin cria registro manual (esqueceu de bater). */
  async criarManual(input: {
    sellerId: string;
    storeId: string;
    tipo: string;
    timestamp: string;
    justificativa: string;
    userId?: string;
  }) {
    if (!PontoService.TIPOS_VALIDOS.includes(input.tipo)) {
      throw new BadRequestException('Tipo inválido');
    }
    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: input.sellerId },
    });
    if (!seller) throw new NotFoundException('Funcionária não encontrada');

    return (this.prisma as any).pontoRegistro.create({
      data: {
        sellerId: input.sellerId,
        storeId: input.storeId,
        tipo: input.tipo,
        source: 'manual_admin',
        timestamp: new Date(input.timestamp),
        justificado: true,
        justificativa: input.justificativa,
        justificadoBy: input.userId || null,
        justificadoAt: new Date(),
      },
    });
  }
}
