import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ActiveSellersService — whitelist de vendedoras ATIVAS no PDV por loja.
 *
 * Admin marca em /retaguarda/vendedoras-ativas quais funcionárias do Wincred
 * aparecem no modal Vendedora do PDV. Reduz o ruído de 80+ nomes pra só
 * as que realmente trabalham ali.
 */
@Injectable()
export class ActiveSellersService {
  private readonly logger = new Logger(ActiveSellersService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lista vendedoras ativas de uma loja. Retorna [] se a loja ainda
   * não configurou — nesse caso o PDV cai no fallback (busca direto no Wincred).
   */
  async list(storeCode: string) {
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    let rows: any[] = await (this.prisma as any).pdvActiveSeller.findMany({
      where: { storeCode },
      orderBy: { nome: 'asc' },
    });

    // AUTO-REPARO (23/07): um bug do sync apagou vendedoras legítimas da
    // whitelist (código de funcionária repete entre lojas). Toda leitura
    // reconcilia: funcionária ATIVA com "loja onde trabalha" = esta loja e
    // que não está na lista volta sozinha — nenhuma loja fica sem vendedora.
    try {
      const ativos: any[] = await (this.prisma as any).seller.findMany({
        where: { active: true, storeCodeOrigin: storeCode },
        select: { id: true, wincredCodigo: true, name: true, apelido: true },
      });
      const have = new Set(rows.map((r) => String(r.codigo).trim()));
      let repos = 0;
      for (const s of ativos) {
        const codigo = String(s.wincredCodigo || s.id).trim();
        if (!codigo || have.has(codigo)) continue;
        const nome = String(s.apelido || s.name).trim();
        const criado = await (this.prisma as any).pdvActiveSeller.upsert({
          where: { storeCode_codigo: { storeCode, codigo } },
          create: { storeCode, codigo, nome },
          update: {},
        });
        rows.push(criado);
        repos++;
      }
      if (repos > 0) {
        rows.sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
        this.logger?.log?.(`[active-sellers] auto-reparo: ${repos} vendedora(s) devolvida(s) à loja ${storeCode}`);
      }
    } catch { /* lista segue como está */ }
    // APELIDO (22/07): vem do cadastro da funcionária (Seller, casado pelo
    // código do Wincred) — é o que o popup do PDV mostra no lugar do nome.
    try {
      const sellers: any[] = await (this.prisma as any).seller.findMany({
        where: { apelido: { not: null } },
        select: { id: true, wincredCodigo: true, name: true, apelido: true },
      });
      const norm = (s: any) => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '') || '0';
      const normNome = (s: any) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
      // codigo da whitelist pode ser o código Wincred OU o Seller.id (funcionária
      // criada direto no Flow). Ficha SEM código Wincred → casa pelo NOME
      // (a whitelist herdou o nome da mesma tabela do Giga).
      const porCodigo = new Map(
        sellers.filter((s) => s.wincredCodigo).map((s) => [norm(s.wincredCodigo), s.apelido]),
      );
      const porId = new Map(sellers.map((s) => [String(s.id), s.apelido]));
      const porNome = new Map(sellers.map((s) => [normNome(s.name), s.apelido]));
      return rows.map((r) => ({
        ...r,
        apelido:
          porId.get(String(r.codigo)) ||
          porCodigo.get(norm(r.codigo)) ||
          porNome.get(normNome(r.nome)) ||
          null,
      }));
    } catch {
      return rows;
    }
  }

  /**
   * Adiciona uma vendedora à whitelist da loja. Idempotente — se já existir
   * o par (storeCode, codigo), atualiza o nome (caso tenha mudado no Wincred).
   */
  async add(input: { storeCode: string; codigo: string; nome: string }) {
    const storeCode = String(input.storeCode || '').trim();
    const codigo = String(input.codigo || '').trim();
    const nome = String(input.nome || '').trim();
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    if (!codigo) throw new BadRequestException('codigo obrigatório');
    if (!nome) throw new BadRequestException('nome obrigatório');

    return (this.prisma as any).pdvActiveSeller.upsert({
      where: { storeCode_codigo: { storeCode, codigo } },
      update: { nome },
      create: { storeCode, codigo, nome },
    });
  }

  /** Remove vendedora da whitelist. */
  async remove(id: string) {
    if (!id) throw new BadRequestException('id obrigatório');
    const exists = await (this.prisma as any).pdvActiveSeller.findUnique({
      where: { id },
    });
    if (!exists) throw new NotFoundException('Vendedora ativa não encontrada');
    return (this.prisma as any).pdvActiveSeller.delete({ where: { id } });
  }

  /**
   * Bulk replace — substitui TODA a lista da loja por uma nova lista.
   * Útil pro admin marcar várias e salvar de uma vez.
   */
  async replaceAll(input: {
    storeCode: string;
    sellers: Array<{ codigo: string; nome: string }>;
  }) {
    const storeCode = String(input.storeCode || '').trim();
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');

    return this.prisma.$transaction(async (tx) => {
      // Remove todas
      await (tx as any).pdvActiveSeller.deleteMany({ where: { storeCode } });
      // Cria todas (deduplicando por codigo)
      const seen = new Set<string>();
      const dedup = input.sellers.filter((s) => {
        const k = String(s.codigo || '').trim();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (dedup.length === 0) return { storeCode, count: 0 };
      await (tx as any).pdvActiveSeller.createMany({
        data: dedup.map((s) => ({
          storeCode,
          codigo: String(s.codigo).trim(),
          nome: String(s.nome || '').trim(),
        })),
      });
      return { storeCode, count: dedup.length };
    });
  }
}
