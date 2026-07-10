import { Injectable, Logger, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AccessLevel,
  makeSecret,
  setOperatorPins,
  pinBelongsToOther,
  OperatorPin,
} from '../auth/auth-levels.util';

// Níveis que uma operadora pode ter (VENDEDOR não autoriza nada, não tem PIN).
export const OPERATOR_LEVELS: AccessLevel[] = ['CAIXA', 'SUPERVISOR', 'GERENTE', 'MASTER', 'SUPREMA'];

const PIN_LEN = 6;

/** Bloqueia PIN óbvio: repetido, sequência crescente/decrescente. */
function pinFraco(pin: string): boolean {
  if (/^(\d)\1{5}$/.test(pin)) return true; // 000000, 111111...
  const seqUp = '0123456789';
  const seqDown = '9876543210';
  if (seqUp.includes(pin) || seqDown.includes(pin)) return true; // 123456, 654321...
  return false;
}

function cpfDigits(v: any): string {
  return String(v || '').replace(/\D/g, '');
}

export interface OperadorUpsert {
  cpf: string;
  nome: string;
  nivel: AccessLevel;
  pin?: string;        // opcional no update (só quando quer (re)definir)
  storeCode?: string;
  ativo?: boolean;
}

/** Item retornado pra tela — NUNCA inclui hash/salt/PIN. */
export interface OperadorView {
  cpf: string;
  nome: string;
  nivel: AccessLevel;
  ativo: boolean;
  storeCode: string | null;
  temPin: boolean;
}

/**
 * PINs pessoais de liberação do PDV (por CPF, global). No boot e a cada gravação
 * empurra a lista de ATIVOS pro auth-levels.util (setOperatorPins), que dá o
 * "quem autorizou". Nunca guarda/serve o PIN em claro — só o hash (sha256+salt).
 */
@Injectable()
export class OperadorPinService implements OnModuleInit {
  private readonly logger = new Logger(OperadorPinService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.reload();
    } catch (e: any) {
      this.logger.warn(`[operador-pin] boot falhou: ${e?.message}`);
    }
  }

  /** Recarrega os ativos pro motor de auth (memória). */
  async reload(): Promise<void> {
    const rows = await (this.prisma as any).operadorPin.findMany({ where: { ativo: true } });
    const list: OperatorPin[] = rows.map((r: any) => ({
      cpf: r.cpf,
      nome: r.nome,
      nivel: r.nivel as AccessLevel,
      salt: r.pinSalt,
      hash: r.pinHash,
    }));
    setOperatorPins(list);
    this.logger.log(`[operador-pin] ${list.length} PIN(s) ativos carregados.`);
  }

  /**
   * Lista escopada: gerente (role=store) vê só as da SUA loja; matriz vê todas.
   * NUNCA devolve hash/PIN.
   */
  async list(user: { role?: string; storeCode?: string }): Promise<OperadorView[]> {
    const where: any = {};
    if (user?.role === 'store' && user?.storeCode) {
      where.storeCode = user.storeCode;
    }
    const rows = await (this.prisma as any).operadorPin.findMany({
      where,
      orderBy: [{ ativo: 'desc' }, { nome: 'asc' }],
    });
    return rows.map((r: any) => ({
      cpf: r.cpf,
      nome: r.nome,
      nivel: r.nivel as AccessLevel,
      ativo: r.ativo,
      storeCode: r.storeCode || null,
      temPin: !!r.pinHash,
    }));
  }

  /**
   * EQUIPE da loja pra tela de PIN — evita digitar de novo quem já existe.
   * Cruza as vendedoras ativas do PDV (PdvActiveSeller) com o RH (Seller,
   * que tem CPF e cargo) e marca quem já tem PIN. Nenhum dos três cadastros
   * tem FK entre si — o vínculo é código Wincred e nome normalizado.
   */
  async equipe(
    user: { role?: string; storeCode?: string },
    storeCodeParam?: string,
  ): Promise<Array<{
    nome: string;
    cpf: string | null;
    cargo: string | null;
    nivelSugerido: AccessLevel;
    storeCode: string | null;
    jaTemPin: boolean;
  }>> {
    const storeCode =
      user?.role === 'store' && user?.storeCode
        ? user.storeCode
        : (storeCodeParam ? String(storeCodeParam).trim() : null);

    const prisma: any = this.prisma;
    const normNome = (s: any) =>
      String(s || '').trim().toUpperCase().normalize('NFD')
        .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
    // Lojas aparecem como '15', 'LJ15', '015' dependendo do cadastro —
    // compara sem prefixo LJ e sem zeros à esquerda.
    const normLoja = (s: any) =>
      String(s || '').trim().toUpperCase().replace(/^LJ/, '').replace(/^0+/, '');
    const lojaAlvo = storeCode ? normLoja(storeCode) : null;

    // As três fontes são tabelas pequenas (dezenas/centenas de linhas) —
    // busca tudo e cruza em JS pra tolerar os formatos de loja divergentes.
    const [ativas, sellers, pins] = await Promise.all([
      prisma.pdvActiveSeller.findMany().catch(() => []),
      prisma.seller.findMany({
        where: { active: true },
        select: {
          name: true, cpf: true, cargo: true, wincredCodigo: true,
          storeCodeOrigin: true, responsibleStore: { select: { code: true } },
        },
      }).catch(() => []),
      prisma.operadorPin.findMany({ select: { cpf: true, nome: true } }).catch(() => []),
    ]);

    const pinCpfs = new Set(pins.map((p: any) => cpfDigits(p.cpf)).filter(Boolean));
    const pinNomes = new Set(pins.map((p: any) => normNome(p.nome)).filter(Boolean));

    const sellerByCodigo = new Map<string, any>();
    const sellerByNome = new Map<string, any>();
    for (const s of sellers) {
      if (s.wincredCodigo) sellerByCodigo.set(String(s.wincredCodigo).trim(), s);
      sellerByNome.set(normNome(s.name), s);
    }

    const nivelFromCargo = (cargo: string | null): AccessLevel => {
      const c = String(cargo || '').toUpperCase();
      if (c.startsWith('GERENTE')) return 'GERENTE';
      if (c.startsWith('LIDER')) return 'SUPERVISOR';
      return 'CAIXA';
    };

    const out = new Map<string, {
      nome: string; cpf: string | null; cargo: string | null;
      nivelSugerido: AccessLevel; storeCode: string | null; jaTemPin: boolean;
    }>();
    const push = (nome: string, seller: any, loja: string | null) => {
      const key = normNome(nome);
      if (!key || out.has(key)) return;
      const cpf = seller?.cpf ? cpfDigits(seller.cpf) : '';
      out.set(key, {
        nome: String(nome).trim(),
        cpf: cpf.length === 11 ? cpf : null,
        cargo: seller?.cargo || null,
        nivelSugerido: nivelFromCargo(seller?.cargo || null),
        storeCode: loja,
        jaTemPin:
          (cpf.length === 11 && pinCpfs.has(cpf)) || pinNomes.has(key),
      });
    };

    // 1) Vendedoras ativas do PDV da loja (a lista que a loja já conhece)
    for (const a of ativas) {
      if (lojaAlvo && normLoja(a.storeCode) !== lojaAlvo) continue;
      const seller =
        sellerByCodigo.get(String(a.codigo || '').trim()) ||
        sellerByNome.get(normNome(a.nome)) || null;
      push(a.nome, seller, a.storeCode || null);
    }
    // 2) Funcionárias do RH da mesma loja que não estão na whitelist do PDV
    for (const s of sellers) {
      const lojaSeller = s.responsibleStore?.code || s.storeCodeOrigin || null;
      if (lojaAlvo && (!lojaSeller || normLoja(lojaSeller) !== lojaAlvo)) continue;
      push(s.name, s, lojaSeller);
    }

    return Array.from(out.values()).sort((a, b) => {
      if (a.jaTemPin !== b.jaTemPin) return a.jaTemPin ? 1 : -1; // sem PIN primeiro
      return a.nome.localeCompare(b.nome, 'pt-BR');
    });
  }

  /** Cria/atualiza uma operadora. PIN só é (re)definido se vier no input. */
  async upsert(input: OperadorUpsert): Promise<OperadorView> {
    const cpf = cpfDigits(input.cpf);
    if (cpf.length !== 11) throw new BadRequestException('CPF inválido — são 11 números.');
    const nome = String(input.nome || '').trim();
    if (nome.length < 3) throw new BadRequestException('Informe o nome completo.');
    if (!OPERATOR_LEVELS.includes(input.nivel)) {
      throw new BadRequestException(`Função inválida. Use uma de: ${OPERATOR_LEVELS.join(', ')}.`);
    }
    const storeCode = input.storeCode ? String(input.storeCode).trim().slice(0, 20) : null;

    const existing = await (this.prisma as any).operadorPin.findUnique({ where: { cpf } });

    // PIN: obrigatório na criação; no update só se veio.
    let pinFields: { pinSalt: string; pinHash: string } | null = null;
    if (input.pin != null && String(input.pin).length > 0) {
      const pin = String(input.pin).replace(/\D/g, '');
      if (pin.length !== PIN_LEN) throw new BadRequestException(`O PIN precisa ter ${PIN_LEN} dígitos.`);
      if (pinFraco(pin)) throw new BadRequestException('PIN muito óbvio (evite sequência ou dígitos repetidos).');
      if (pinBelongsToOther(pin, cpf)) throw new BadRequestException('PIN inválido — já usado por outra pessoa. Cadastre outro.');
      const s = makeSecret(pin);
      pinFields = { pinSalt: s.salt, pinHash: s.hash };
    } else if (!existing) {
      throw new BadRequestException('Defina um PIN de 6 dígitos pra nova operadora.');
    }

    const ativo = input.ativo != null ? !!input.ativo : existing ? existing.ativo : true;

    if (existing) {
      await (this.prisma as any).operadorPin.update({
        where: { cpf },
        data: { nome, nivel: input.nivel, storeCode, ativo, ...(pinFields || {}) },
      });
    } else {
      await (this.prisma as any).operadorPin.create({
        data: { cpf, nome, nivel: input.nivel, storeCode, ativo, ...(pinFields as any) },
      });
    }
    await this.reload();
    this.logger.log(`[operador-pin] ${existing ? 'atualizada' : 'criada'} ${nome} (${input.nivel})`);
    return {
      cpf, nome, nivel: input.nivel, ativo, storeCode, temPin: true,
    };
  }

  /** Redefine só o PIN de uma operadora. */
  async setPin(cpf: string, pin: string): Promise<{ ok: true }> {
    const c = cpfDigits(cpf);
    const p = String(pin || '').replace(/\D/g, '');
    if (p.length !== PIN_LEN) throw new BadRequestException(`O PIN precisa ter ${PIN_LEN} dígitos.`);
    if (pinFraco(p)) throw new BadRequestException('PIN muito óbvio (evite sequência ou dígitos repetidos).');
    if (pinBelongsToOther(p, c)) throw new BadRequestException('PIN inválido — já usado por outra pessoa. Cadastre outro.');
    const row = await (this.prisma as any).operadorPin.findUnique({ where: { cpf: c } });
    if (!row) throw new NotFoundException('Operadora não encontrada.');
    const s = makeSecret(p);
    await (this.prisma as any).operadorPin.update({
      where: { cpf: c },
      data: { pinSalt: s.salt, pinHash: s.hash },
    });
    await this.reload();
    return { ok: true };
  }

  /** Liga/desliga uma operadora (sem apagar — mantém histórico/rastro). */
  async setAtivo(cpf: string, ativo: boolean): Promise<{ ok: true }> {
    const c = cpfDigits(cpf);
    const row = await (this.prisma as any).operadorPin.findUnique({ where: { cpf: c } });
    if (!row) throw new NotFoundException('Operadora não encontrada.');
    await (this.prisma as any).operadorPin.update({ where: { cpf: c }, data: { ativo: !!ativo } });
    await this.reload();
    return { ok: true };
  }
}
