import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EvolutionClient } from './evolution.client';

type SegmentoParams = {
  de?: string | null;
  ate?: string | null;
  apenasMulheres?: boolean;
  limite?: number;
};

/**
 * CAMPANHA DE WHATSAPP PELO FLOWOPS (dono, 15/08/2026).
 *
 * Substitui o disparo órfão do n8n (community node do Evolution desinstalado,
 * sem dono desde que o Matheus saiu). Aqui a operadora escolhe um público, o
 * sistema monta a fila e dispara PAUSADO pelo Evolution, com kill-switch.
 *
 * DEFESAS CONTRA BAN (as que a gente combinou):
 *   · intervalo ALEATÓRIO entre envios (nunca robótico);
 *   · 1 envio por campanha por ciclo de 30s → ritmo humano;
 *   · KILL-SWITCH: N falhas seguidas → pausa sozinho (número caiu/baniu);
 *   · mensagens variadas ({nome} + rodízio de textos), sem link seco.
 */
@Injectable()
export class WhatsappCampaignService {
  private readonly logger = new Logger(WhatsappCampaignService.name);
  private processando = false;
  private readonly MAX_FALHAS_SEGUIDAS = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly evo: EvolutionClient,
  ) {}

  async status() {
    const configurado = this.evo.configurado();
    const conexao = configurado
      ? await this.evo.instanciaConectada().catch(() => ({ ok: false }))
      : null;
    return { configurado, instancia: this.evo.instancia || null, conexao };
  }

  // ── Segmento (público) ─────────────────────────────────────────────
  /** `de`/`ate` só entram se forem YYYY-MM-DD — anti-injeção no raw SQL. */
  private diaLimpo(s?: string | null): string | null {
    return s && /^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? String(s) : null;
  }

  private sqlSegmento(p: SegmentoParams) {
    const cond = `COALESCE(NULLIF(regexp_replace(COALESCE(whatsapp,''),'\\D','','g'),''), regexp_replace(COALESCE(phone,''),'\\D','','g'))`;
    const w: string[] = [`name IS NOT NULL`, `LENGTH(${cond}) >= 10`];
    const de = this.diaLimpo(p.de);
    const ate = this.diaLimpo(p.ate);
    if (de) w.push(`(last_order_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') >= '${de}'`);
    if (ate) w.push(`(last_order_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') < ('${ate}'::date + 1)`);
    if (p.apenasMulheres) w.push(`(gender IS NULL OR gender NOT ILIKE 'm%')`);
    return { cond, where: w.join(' AND ') };
  }

  async previewSegmento(p: SegmentoParams) {
    const { where } = this.sqlSegmento(p);
    const tot = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int n FROM "customers" WHERE ${where}`,
    );
    const amostra = await this.prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM "customers" WHERE ${where} ORDER BY ltv_cents DESC NULLS LAST LIMIT 5`,
    );
    return { total: Number(tot[0]?.n ?? 0), amostra: amostra.map((a) => a.name) };
  }

  private norm(d: string): string {
    d = String(d).replace(/\D/g, '');
    if (d.length <= 11) d = '55' + d;
    return d;
  }
  private primeiroNome(nome: string): string {
    const t = String(nome).trim().split(/\s+/)[0] || '';
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }

  async criarCampanha(input: {
    nome?: string;
    segmento?: SegmentoParams;
    mensagens?: string[];
    imagemUrl?: string | null;
    intervaloMinSeg?: number;
    intervaloMaxSeg?: number;
    iniciar?: boolean;
  }) {
    const msgs = (input.mensagens || []).map((m) => String(m || '').trim()).filter(Boolean);
    if (!msgs.length) throw new BadRequestException('Escreva pelo menos uma mensagem.');

    const seg = input.segmento || {};
    const { cond, where } = this.sqlSegmento(seg);
    const limite = Math.min(Math.max(Number(seg.limite) || 50, 1), 500);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ name: string; fone: string }>>(
      `SELECT name, ${cond} AS fone FROM "customers" WHERE ${where} ORDER BY ltv_cents DESC NULLS LAST LIMIT ${limite}`,
    );
    if (!rows.length) throw new BadRequestException('Nenhum contato nesse público.');

    const camp = await (this.prisma as any).whatsappCampaign.create({
      data: {
        nome: input.nome || 'Campanha WhatsApp',
        segmento: JSON.stringify(seg),
        mensagens: JSON.stringify(msgs),
        imagemUrl: input.imagemUrl || null,
        status: input.iniciar ? 'enviando' : 'rascunho',
        intervaloMinSeg: Math.max(Number(input.intervaloMinSeg) || 45, 20),
        intervaloMaxSeg: Math.max(Number(input.intervaloMaxSeg) || 120, 40),
        total: rows.length,
      },
    });

    const vistos = new Set<string>();
    const dados: Array<{ campaignId: string; nome: string; fone: string; mensagem: string }> = [];
    rows.forEach((r, i) => {
      const fone = this.norm(r.fone);
      if (fone.length < 12 || vistos.has(fone)) return;
      vistos.add(fone);
      const nome = this.primeiroNome(r.name);
      const mensagem = msgs[i % msgs.length].replace(/\{nome\}/gi, nome);
      dados.push({ campaignId: camp.id, nome, fone, mensagem });
    });
    await (this.prisma as any).whatsappCampaignRecipient.createMany({ data: dados });
    await (this.prisma as any).whatsappCampaign.update({ where: { id: camp.id }, data: { total: dados.length } });
    this.logger.log(`[wa] campanha ${camp.id} criada — ${dados.length} contatos (${input.iniciar ? 'enviando' : 'rascunho'})`);
    return { id: camp.id, total: dados.length, status: camp.status };
  }

  listar() {
    return (this.prisma as any).whatsappCampaign.findMany({ orderBy: { criadoEm: 'desc' }, take: 50 });
  }

  async detalhe(id: string) {
    const c = await (this.prisma as any).whatsappCampaign.findUnique({ where: { id } });
    if (!c) throw new BadRequestException('Campanha não encontrada.');
    const recipients = await (this.prisma as any).whatsappCampaignRecipient.findMany({
      where: { campaignId: id },
      orderBy: { criadoEm: 'asc' },
      take: 500,
    });
    return { ...c, recipients };
  }

  acao(id: string, acao: string) {
    const map: Record<string, string> = { iniciar: 'enviando', pausar: 'pausada', retomar: 'enviando', cancelar: 'concluida' };
    const status = map[acao];
    if (!status) throw new BadRequestException('Ação inválida.');
    const data: any = { status };
    if (acao === 'retomar' || acao === 'iniciar') {
      data.falhasSeguidas = 0;
      data.pausaMotivo = null;
    }
    return (this.prisma as any).whatsappCampaign.update({ where: { id }, data });
  }

  /** Prévia: manda o texto (e a foto, se houver) pra um número — teste do dono. */
  async previa(fone: string, mensagem: string, imagemUrl?: string | null) {
    if (!this.evo.configurado()) {
      throw new BadRequestException('Evolution ainda não ligado — falta a chave (EVOLUTION_URL/KEY/INSTANCE) no Railway.');
    }
    const f = this.norm(String(fone || ''));
    if (f.length < 12) throw new BadRequestException('Telefone inválido.');
    await this.evo.enviarTexto(f, mensagem || "Teste Lurd's 💛");
    if (imagemUrl) {
      // No TESTE a foto não é silenciosa: se falhar, o dono precisa saber ANTES
      // de disparar. (No lote real ela é best-effort pra não travar a fila.)
      await this.evo.enviarImagem(f, imagemUrl, '').catch((e: any) => {
        throw new BadRequestException(`O texto foi, mas a FOTO falhou: ${e?.message || e}`);
      });
    }
    return { ok: true, comFoto: !!imagemUrl };
  }

  // ── Fila: disparo pausado + kill-switch ────────────────────────────
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'whatsapp-campaign-sender' })
  async processarFila() {
    if (this.processando || !this.evo.configurado()) return;
    this.processando = true;
    try {
      const campanhas = await (this.prisma as any).whatsappCampaign.findMany({ where: { status: 'enviando' } });
      for (const c of campanhas) {
        // KILL-SWITCH: falhas seguidas = número caiu ou baniu → para sozinho.
        if (c.falhasSeguidas >= this.MAX_FALHAS_SEGUIDAS) {
          await (this.prisma as any).whatsappCampaign.update({
            where: { id: c.id },
            data: { status: 'pausada', pausaMotivo: `${c.falhasSeguidas} falhas seguidas — parei pra proteger o número` },
          });
          this.logger.warn(`[wa] campanha ${c.id} PAUSADA (kill-switch, ${c.falhasSeguidas} falhas)`);
          continue;
        }
        // PACING: só dispara se passou o intervalo aleatório desde o último.
        const min = c.intervaloMinSeg || 45;
        const max = Math.max(c.intervaloMaxSeg || 120, min + 1);
        const esperaMs = (min + Math.floor(Math.random() * (max - min))) * 1000;
        if (c.ultimoEnvioEm && Date.now() - new Date(c.ultimoEnvioEm).getTime() < esperaMs) continue;

        const rec = await (this.prisma as any).whatsappCampaignRecipient.findFirst({
          where: { campaignId: c.id, status: 'pendente' },
          orderBy: { criadoEm: 'asc' },
        });
        if (!rec) {
          await (this.prisma as any).whatsappCampaign.update({ where: { id: c.id }, data: { status: 'concluida' } });
          continue;
        }

        try {
          await this.evo.enviarTexto(rec.fone, rec.mensagem);
          if (c.imagemUrl) await this.evo.enviarImagem(rec.fone, c.imagemUrl).catch(() => undefined);
          await (this.prisma as any).whatsappCampaignRecipient.update({
            where: { id: rec.id },
            data: { status: 'enviado', enviadoEm: new Date(), tentativas: rec.tentativas + 1 },
          });
          await (this.prisma as any).whatsappCampaign.update({
            where: { id: c.id },
            data: { enviados: c.enviados + 1, falhasSeguidas: 0, ultimoEnvioEm: new Date() },
          });
        } catch (e: any) {
          const erro = (e?.message || String(e)).slice(0, 200);
          await (this.prisma as any).whatsappCampaignRecipient.update({
            where: { id: rec.id },
            data: { status: 'falha', erro, tentativas: rec.tentativas + 1 },
          });
          await (this.prisma as any).whatsappCampaign.update({
            where: { id: c.id },
            data: { falhas: c.falhas + 1, falhasSeguidas: c.falhasSeguidas + 1, ultimoEnvioEm: new Date() },
          });
          this.logger.warn(`[wa] falha campanha=${c.id}: ${erro}`);
        }
        // 1 envio por campanha por ciclo — o ritmo humano vem daqui.
      }
    } finally {
      this.processando = false;
    }
  }
}
