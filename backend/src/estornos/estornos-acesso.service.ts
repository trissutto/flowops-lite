import { ForbiddenException, HttpException, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizeResult, authorizeMinLevel } from '../auth/auth-levels.util';
import {
  SESSAO_ESTORNO_MIN,
  assinarSessaoEstorno,
  bloqueioDeSenha,
  lerSessaoEstorno,
  minutosArredondados,
} from '../common/estornos';

/** Quem está operando — vai inteiro pro log de auditoria. */
export interface AtorEstorno {
  userId: string | null;
  nome: string | null;
  ip: string | null;
  dispositivo: string | null;
}

/**
 * A PORTA DOS ESTORNOS (22/09/2026).
 *
 * Duas travas, as duas pedidas pelo dono:
 *  1. senha **MASTER ou SUPREMA** — na entrada E em cada operação de dinheiro
 *     (a senha nunca aparece na tela nem é guardada em lugar nenhum: só o
 *     NÍVEL usado e, quando foi PIN pessoal, quem autorizou);
 *  2. **5 senhas erradas em 15 min fecham a porta** por 15 min, contando por
 *     usuário E por IP.
 *
 * Toda tentativa — inclusive a que falhou — vira linha em `estornos_eventos`,
 * que é insert-only e não expira (o `integration_log` some com 90 dias, então
 * não servia). É essa tabela que alimenta o bloqueio: o contador vive no
 * banco, não na memória do processo, então um deploy no meio não "solta" quem
 * estava bloqueado.
 */
@Injectable()
export class EstornosAcessoService {
  private readonly logger = new Logger(EstornosAcessoService.name);

  constructor(private readonly prisma: PrismaService) {}

  private hmac(segredo: string, texto: string): string {
    return createHmac('sha256', segredo).update(texto).digest('hex');
  }

  /** O mesmo segredo do login (já é fixo em produção — não desloga ninguém). */
  private segredo(): string {
    return String(process.env.JWT_SECRET || 'flowops-estornos-sem-jwt-secret');
  }

  /** Grava um evento de auditoria. Nunca lança (log não pode derrubar operação). */
  async registrar(ev: {
    tipo: string;
    ator?: AtorEstorno;
    nivel?: string | null;
    estornoId?: string | null;
    refId?: string | null;
    refNumero?: string | null;
    statusDe?: string | null;
    statusPara?: string | null;
    detalhe?: string | null;
  }): Promise<void> {
    try {
      await (this.prisma as any).estornoEvento.create({
        data: {
          tipo: String(ev.tipo).slice(0, 30),
          usuarioId: ev.ator?.userId ?? null,
          usuarioNome: ev.ator?.nome ?? null,
          nivel: ev.nivel ?? null,
          estornoId: ev.estornoId ?? null,
          refId: ev.refId ?? null,
          refNumero: ev.refNumero ?? null,
          statusDe: ev.statusDe ?? null,
          statusPara: ev.statusPara ?? null,
          detalhe: ev.detalhe ? String(ev.detalhe).slice(0, 2000) : null,
          ip: ev.ator?.ip ?? null,
          dispositivo: ev.ator?.dispositivo ?? null,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[estornos] evento "${ev.tipo}" não gravado: ${e?.message || e}`);
    }
  }

  /**
   * VALIDA A SENHA de uma operação. Lança 429 se a porta está fechada por
   * tentativa errada, 403 se a senha não serve — e registra os dois casos.
   */
  async autorizar(input: {
    password?: string;
    ator: AtorEstorno;
    acao: string;
    refId?: string | null;
    refNumero?: string | null;
  }): Promise<AuthorizeResult> {
    await this.conferirBloqueio(input.ator);
    try {
      const auth = authorizeMinLevel(input.password, 'MASTER');
      await this.registrar({
        tipo: 'acesso_ok',
        ator: input.ator,
        nivel: auth.level,
        refId: input.refId ?? null,
        refNumero: input.refNumero ?? null,
        detalhe: `${input.acao}${auth.byNome ? ` · PIN de ${auth.byNome}` : ''}`,
      });
      return auth;
    } catch (e: any) {
      await this.registrar({
        tipo: 'acesso_negado',
        ator: input.ator,
        refId: input.refId ?? null,
        refNumero: input.refNumero ?? null,
        detalhe: `${input.acao} · ${String(e?.message || 'senha inválida').slice(0, 120)}`,
      });
      this.logger.warn(
        `[estornos] senha recusada em "${input.acao}" — usuário ${input.ator.nome || input.ator.userId || '?'} ip ${input.ator.ip || '?'}`,
      );
      throw new ForbiddenException(
        'Senha Master/Suprema inválida ou sem nível suficiente para estornos.',
      );
    }
  }

  /** A porta está fechada por senha errada demais? */
  private async conferirBloqueio(ator: AtorEstorno): Promise<void> {
    const desde = new Date(Date.now() - 60 * 60_000);
    const ou: any[] = [];
    if (ator.userId) ou.push({ usuarioId: ator.userId });
    if (ator.ip) ou.push({ ip: ator.ip });
    if (!ou.length) return;
    const erros: Array<{ createdAt: Date }> = await (this.prisma as any).estornoEvento.findMany({
      where: { tipo: 'acesso_negado', createdAt: { gte: desde }, OR: ou },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const b = bloqueioDeSenha(erros.map((e) => ({ em: e.createdAt })));
    if (!b.bloqueado) return;
    await this.registrar({
      tipo: 'acesso_bloqueado',
      ator,
      detalhe: `${b.tentativas} senhas erradas na última janela — liberado em ${minutosArredondados(b.faltamMs)} min`,
    });
    throw new HttpException(
      `Muitas senhas erradas. Tente de novo em ${minutosArredondados(b.faltamMs)} minuto(s).`,
      429,
    );
  }

  /**
   * ENTRADA NA TELA: valida a senha e devolve um bilhete curto (15 min) que as
   * telas de LEITURA usam. Operação de dinheiro pede a senha de novo — o
   * bilhete só abre a porta, nunca autoriza estorno.
   */
  async abrirSessao(password: string | undefined, ator: AtorEstorno) {
    const auth = await this.autorizar({ password, ator, acao: 'entrada na tela de estornos' });
    const expEm = Date.now() + SESSAO_ESTORNO_MIN * 60_000;
    const token = assinarSessaoEstorno(
      { userId: ator.userId || 'sem-usuario', nivel: auth.level, expEm },
      this.segredo(),
      this.hmac.bind(this),
    );
    return {
      token,
      nivel: auth.level,
      expiraEm: new Date(expEm),
      minutos: SESSAO_ESTORNO_MIN,
      autorizadoPor: auth.byNome,
    };
  }

  /** As rotas de leitura exigem o bilhete — sem ele, nada de dado de pagamento. */
  exigirSessao(token: string | undefined): { userId: string; nivel: string } {
    const s = lerSessaoEstorno(token, this.segredo(), this.hmac.bind(this));
    if (!s) {
      throw new ForbiddenException('Sessão de estornos expirada — digite a senha Master/Suprema de novo.');
    }
    return s;
  }
}
