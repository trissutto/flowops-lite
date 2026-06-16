import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Retorna chave YYYY-MM-DD da data NA TIMEZONE DE SÃO PAULO (UTC-3).
 * Usar isso pra agrupar batidas por dia — toISOString() usaria UTC e
 * jogaria batidas das 22h pro dia seguinte (bug calssico jun/2026).
 */
function dateKeyBrasil(d: Date): string {
  // 'en-CA' formata como 'YYYY-MM-DD' nativamente; timeZone faz a conversao.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Retorna dia-da-semana (0=DOM..6=SAB) na timezone de São Paulo. */
function dayOfWeekBrasil(d: Date): number {
  const ymd = dateKeyBrasil(d).split('-').map(Number);
  // Cria Date local em UTC com YMD do BR pra pegar weekday sem nova conversão
  const fake = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2]));
  return fake.getUTCDay();
}

/**
 * Retorna o INÍCIO do dia (00:00:00) NA TIMEZONE BRASIL, como Date UTC.
 * Ex: 00:00:00 BR de 15/06 = 03:00:00 UTC de 15/06.
 * Usar pra queries tipo "batidas de hoje" sem cair no dia errado.
 */
function inicioDoDiaBrasil(ref: Date): Date {
  const ymd = dateKeyBrasil(ref).split('-').map(Number);
  // 00:00:00 horário BR (UTC-3) = 03:00:00 UTC
  return new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2], 3, 0, 0, 0));
}

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

  /** Sequência canônica do dia. Usado pra auto-detectar próxima batida. */
  static readonly SEQUENCIA_DIA = [
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

  /**
   * Fire-and-forget: sobe snapshot pro R2 e dá UPDATE no PontoRegistro.
   * Não retorna Promise — é chamado SEM await pra não bloquear a resposta.
   * Erros são silenciosamente logados — registro continua válido sem foto.
   */
  private uploadSnapshotAndUpdate(
    registroId: string,
    sellerId: string,
    snapshotBase64: string,
    prefix: string,
  ): void {
    // setImmediate libera o event loop pra responder antes
    setImmediate(async () => {
      try {
        const url = await this.uploadSnapshot(sellerId, snapshotBase64, prefix);
        if (!url) return;
        await (this.prisma as any).pontoRegistro.update({
          where: { id: registroId },
          data: { faceSnapshot: url },
        });
      } catch (e: any) {
        this.logger.warn(
          `[ponto] upload bg snapshot falhou (registro ${registroId}): ${e?.message}`,
        );
      }
    });
  }

  // ── REGISTRAR PONTO ───────────────────────────────────────────────

  /**
   * Retorna o próximo tipo da sequência do dia que ainda NÃO foi batido.
   * Retorna null se já completou os 4.
   */
  async getNextTipoForSeller(sellerId: string): Promise<string | null> {
    const now = new Date();
    // Usa "inicio do dia em BR" pra a janela bater com o conceito de "hoje"
    // do funcionario. setHours(0,0,0,0) usaria TZ do servidor (UTC no Railway).
    const inicioDia = inicioDoDiaBrasil(now);

    const batidas = await (this.prisma as any).pontoRegistro.findMany({
      where: {
        sellerId,
        timestamp: { gte: inicioDia, lte: now },
      },
      select: { tipo: true },
    });

    const batidasSet = new Set(batidas.map((b: any) => b.tipo));
    return PontoService.SEQUENCIA_DIA.find((t) => !batidasSet.has(t)) || null;
  }

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
    let tipo = (input.tipo || '').toLowerCase();

    // tipo === 'auto' → backend detecta a próxima batida da sequência do dia.
    // Vendedora não escolhe nada; primeira do dia vira entrada, segunda saída-almoço, etc.
    if (tipo === 'auto') {
      const next = await this.getNextTipoForSeller(input.sellerId);
      if (!next) {
        throw new BadRequestException(
          'Você já bateu os 4 pontos do dia. Volta amanhã!',
        );
      }
      tipo = next;
    }

    if (!PontoService.TIPOS_VALIDOS.includes(tipo)) {
      throw new BadRequestException(
        `Tipo inválido. Use: ${PontoService.TIPOS_VALIDOS.join(', ')} ou "auto"`,
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

    // PERFORMANCE: cria registro SEM esperar upload do snapshot R2.
    // R2 upload pode levar 500-2000ms (rede externa) — bloquear a resposta
    // fazia o PDV mostrar "Registrando..." por 2 segundos. Solução:
    //  1) Salva DB imediatamente (faceSnapshot=null)
    //  2) Retorna sucesso pro frontend (resposta em ~50ms)
    //  3) Em background, sobe snapshot pro R2 e dá UPDATE no registro
    // Se upload falhar, o registro continua válido — só perde a foto de audit.
    const reg = await (this.prisma as any).pontoRegistro.create({
      data: {
        sellerId: input.sellerId,
        storeId: input.storeId,
        tipo,
        source,
        faceConfidence: input.faceConfidence ?? null,
        faceSnapshot: null,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        ip: input.ip ?? null,
        observacoes: input.observacoes ?? null,
      },
    });

    // Fire-and-forget: sobe a foto em background e atualiza o registro
    if (input.snapshotBase64) {
      this.uploadSnapshotAndUpdate(reg.id, input.sellerId, input.snapshotBase64, tipo);
    }

    this.logger.log(
      `[ponto] ${seller.name} → ${tipo} @ ${store.name} (conf=${input.faceConfidence?.toFixed(2) ?? '-'})`,
    );

    return {
      ok: true,
      tipo, // tipo final que foi registrado (resolved se veio "auto")
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

    // Agrupa por dia — USA TIMEZONE BRASIL (jun/2026: bug de batida 22:32 BR
    // virava 01:32 UTC do dia seguinte e aparecia no dia errado no espelho)
    const diasMap: Record<string, any[]> = {};
    for (const r of registros) {
      const dKey = dateKeyBrasil(r.timestamp);
      if (!diasMap[dKey]) diasMap[dKey] = [];
      diasMap[dKey].push(r);
    }

    const dias: any[] = [];
    const lastDay = fim.getDate();
    let totalMinTrabalhado = 0;
    let totalMinPrevisto = 0;

    for (let d = 1; d <= lastDay; d++) {
      // Cria data alvo as 12h (meio-dia) pra fugir de qualquer borda de TZ.
      // dateKeyBrasil() vai retornar o YYYY-MM-DD correto na zona BR.
      const dt = new Date(ano, mes - 1, d, 12, 0, 0);
      const dKey = dateKeyBrasil(dt);
      const diaSemana = DIAS_KEY[dayOfWeekBrasil(dt)];
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

  // ── BANCO DE HORAS + HORA EXTRA (CLT 44h) ────────────────────────

  /**
   * Banco de Horas + Hora Extra (referência: CLT Art. 7º + Lei 13.467/2017).
   *
   * Regras aplicadas:
   *  - Jornada máxima legal: 44h/semana (8h/dia + 4h sábado é padrão comércio)
   *  - Limite diário absoluto: 10h (8h normais + 2h extras)
   *  - HE em dia útil (seg-sáb): +50% sobre hora normal
   *  - HE em domingo/feriado: +100%
   *  - Adicional noturno (22h-5h): +20% → não aplicado aqui (varejo não trabalha de noite)
   *  - Valor hora = salário base / 220h mensais (padrão CLT)
   *
   * Compara com a JORNADA CADASTRADA (sellers.horarioTrabalho):
   *  - Horas previstas vs trabalhadas por dia
   *  - Saldo banco de horas (acumulado do mês)
   *  - Flags de irregularidade:
   *      cadastro_acima_44h → cadastro tem mais de 44h/sem (problema)
   *      dia_acima_10h     → algum dia ultrapassou 10h trabalhadas
   *      sem_almoco_obrigatorio → jornada >6h sem intervalo
   */
  async getBancoHorasMensal(
    sellerId: string,
    ano: number,
    mes: number,
  ) {
    const espelho = await this.getEspelhoMensal(sellerId, ano, mes);

    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: sellerId },
      select: {
        id: true,
        name: true,
        cargo: true,
        salarioBase: true,
        horarioTrabalho: true,
      },
    });
    if (!seller) throw new NotFoundException('Funcionária não encontrada');

    // Parse horário cadastrado pra calcular jornada semanal prevista
    let horarioExpected: any[] = [];
    try {
      horarioExpected = seller.horarioTrabalho
        ? JSON.parse(seller.horarioTrabalho)
        : [];
    } catch {
      horarioExpected = [];
    }

    const toMin = (s: string) => {
      const [h, m] = (s || '0:0').split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };

    // Total semanal previsto (do cadastro)
    let minSemanaPrevisto = 0;
    for (const h of horarioExpected) {
      if (h.folga) continue;
      let m = toMin(h.fim) - toMin(h.inicio);
      if (h.almocoInicio && h.almocoFim) {
        const a = toMin(h.almocoFim) - toMin(h.almocoInicio);
        if (a > 0) m -= a;
      }
      minSemanaPrevisto += Math.max(0, m);
    }

    // Limites CLT
    const LIMITE_SEMANAL_LEGAL_MIN = 44 * 60; // 2640 min
    const LIMITE_DIARIO_MAX_MIN = 10 * 60; // 600 min
    const MINUTOS_JORNADA_MENSAL = 220 * 60; // 13200 min = base CLT

    // Valor hora (R$)
    const salarioBase = Number(seller.salarioBase || 0);
    const valorHoraNormal = salarioBase > 0 ? salarioBase / 220 : 0;
    const valorHoraExtra50 = valorHoraNormal * 1.5;
    const valorHoraExtra100 = valorHoraNormal * 2.0;

    // Processa dias do espelho — separa HE 50% (dia útil) vs HE 100% (dom/feriado)
    const dias = espelho.dias.map((d: any) => {
      const isDomingo = d.diaSemana === 'DOM';
      const previsto = d.minPrevisto;
      const trabalhado = d.minTrabalhado;

      // Saldo do dia (positivo = HE; negativo = falta a compensar)
      const saldo = trabalhado - previsto;

      // Hora extra: só conta o excesso sobre o previsto
      let heMin50 = 0;
      let heMin100 = 0;
      if (saldo > 0) {
        if (isDomingo || d.folga) {
          // Trabalhou em folga/domingo = 100% TUDO que trabalhou (não tem previsto pra descontar)
          heMin100 = trabalhado;
        } else {
          heMin50 = saldo;
        }
      }

      // Irregularidades
      const diaAcima10h = trabalhado > LIMITE_DIARIO_MAX_MIN;

      return {
        ...d,
        heMin50,
        heMin100,
        diaAcima10h,
        valorHe50: (heMin50 / 60) * valorHoraExtra50,
        valorHe100: (heMin100 / 60) * valorHoraExtra100,
      };
    });

    // Totais do mês
    const totalHe50Min = dias.reduce((acc: number, d: any) => acc + d.heMin50, 0);
    const totalHe100Min = dias.reduce((acc: number, d: any) => acc + d.heMin100, 0);
    const totalHeMin = totalHe50Min + totalHe100Min;
    const saldoBancoMin = espelho.totais.minTrabalhado - espelho.totais.minPrevisto;
    const diasAcima10h = dias.filter((d: any) => d.diaAcima10h).length;

    // Valor financeiro
    const valorHe50 = (totalHe50Min / 60) * valorHoraExtra50;
    const valorHe100 = (totalHe100Min / 60) * valorHoraExtra100;
    const valorTotalHe = valorHe50 + valorHe100;

    // Flags de irregularidade no CADASTRO
    const cadastroAcima44h = minSemanaPrevisto > LIMITE_SEMANAL_LEGAL_MIN;
    const semAlmocoObrigatorio = horarioExpected.some(
      (h: any) =>
        !h.folga &&
        toMin(h.fim) - toMin(h.inicio) > 360 && // > 6h
        (!h.almocoInicio ||
          !h.almocoFim ||
          toMin(h.almocoFim) - toMin(h.almocoInicio) < 60),
    );

    return {
      seller: { id: seller.id, name: seller.name, cargo: seller.cargo },
      periodo: { ano, mes },
      cadastro: {
        minSemanaPrevisto,
        horasSemanaPrevisto: minSemanaPrevisto / 60,
        limiteSemanalLegal: LIMITE_SEMANAL_LEGAL_MIN / 60, // 44h
        cadastroAcima44h,
        semAlmocoObrigatorio,
      },
      salario: {
        salarioBase,
        valorHoraNormal,
        valorHoraExtra50,
        valorHoraExtra100,
      },
      totais: {
        minPrevisto: espelho.totais.minPrevisto,
        minTrabalhado: espelho.totais.minTrabalhado,
        saldoBancoMin,
        totalHe50Min,
        totalHe100Min,
        totalHeMin,
        diasAcima10h,
        valorHe50,
        valorHe100,
        valorTotalHe,
      },
      dias,
    };
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
