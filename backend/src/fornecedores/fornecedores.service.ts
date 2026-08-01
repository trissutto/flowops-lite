import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * CADASTRO DE FORNECEDOR — nasce no FLOW.
 *
 * Até 01/08 não existia: a lista de fornecedores do Contas a Pagar e dos
 * pedidos de compra vinha de `wincred_fornecedores`, cópia da tabela do Giga, e
 * não havia nenhum jeito de criar um. Fornecedor novo só pelo Wincred desktop —
 * que ninguém usa mais. Não era dependência do Giga: era ausência de função.
 *
 * O fornecedor é gravado aqui e o Giga recebe réplica pela fila, igual às
 * categorias de produto.
 *
 * ── DECISÕES QUE VIERAM DA MEDIÇÃO (01/08) ──
 *
 * · Faixa 90.000+. `fornecedores.CODIGO` é int(11) e o Giga usa até 10.526.
 * · CNPJ NÃO é obrigatório nem único. O cadastro atual tem 694 fornecedores
 *   sem CNPJ e 76 CNPJs repetidos — exigir qualquer das duas regras travaria a
 *   edição de quem já está lá. A tela avisa sobre repetido, mas não bloqueia.
 * · Os limites de tamanho vêm das colunas reais do Giga (RAZAOSOCIAL 50,
 *   CIDADE 30, UF 2…). Truncar no meio criaria fornecedor duplicado no Giga.
 */
@Injectable()
export class FornecedoresService {
  private readonly logger = new Logger(FornecedoresService.name);

  /** Início da faixa do Flow. Giga usa até 10.526 (medido em 01/08). */
  private static readonly BASE = 90_000;
  private static readonly TETO = 2_000_000_000;

  /** Tamanho máximo de cada campo, igual à coluna do Giga. */
  private static readonly LIMITES: Record<string, number> = {
    razaoSocial: 50, fantasia: 50, cnpj: 18, ie: 18, endereco: 50,
    bairro: 30, cidade: 30, uf: 2, ddd: 5, fone: 16, fax: 16,
    cep: 10, email: 50, contato: 50,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /** Corta no limite da coluna e devolve null pra vazio. */
  private campo(v: any, nome: string): string | null {
    const s = String(v ?? '').trim();
    if (!s) return null;
    return s.slice(0, FornecedoresService.LIMITES[nome] ?? 50);
  }

  async listar(q?: string, apenasFlow = false) {
    const busca = String(q || '').trim();
    const where: any = {};
    if (apenasFlow) where.flowIsSource = true;
    if (busca) {
      where.OR = [
        { razaoSocial: { contains: busca, mode: 'insensitive' } },
        { fantasia: { contains: busca, mode: 'insensitive' } },
        { cnpj: { contains: busca.replace(/\D/g, '') } },
      ];
      if (/^\d+$/.test(busca)) where.OR.push({ codigo: Number(busca) });
    }
    return (this.prisma as any).wincredFornecedor.findMany({
      where,
      orderBy: [{ razaoSocial: 'asc' }],
      take: 200,
    });
  }

  async buscar(codigo: number) {
    const f = await (this.prisma as any).wincredFornecedor.findUnique({ where: { codigo } });
    if (!f) throw new NotFoundException('Fornecedor não encontrado');
    return f;
  }

  /** Avisa (sem bloquear) se o CNPJ já está em uso — o cadastro legado repete. */
  async checarCnpj(cnpj: string, ignorarCodigo?: number) {
    const limpo = String(cnpj || '').replace(/\D/g, '');
    if (limpo.length < 11) return { duplicado: false, existentes: [] as any[] };
    const existentes = await (this.prisma as any).wincredFornecedor.findMany({
      where: {
        cnpj: { contains: limpo },
        ...(ignorarCodigo ? { codigo: { not: ignorarCodigo } } : {}),
      },
      select: { codigo: true, razaoSocial: true, fantasia: true },
      take: 5,
    });
    return { duplicado: existentes.length > 0, existentes };
  }

  private async proximoCodigo(): Promise<number> {
    return this.prisma.$transaction(async (tx: any) => {
      const cur = await tx.categoriaSequence.findUnique({ where: { tipo: 'fornecedor' } });
      const proximo = cur ? Number(cur.proximo) + 1 : FornecedoresService.BASE;
      if (proximo >= FornecedoresService.TETO) {
        throw new BadRequestException('sequência de fornecedor chegou ao teto');
      }
      if (cur) {
        await tx.categoriaSequence.update({ where: { tipo: 'fornecedor' }, data: { proximo } });
      } else {
        await tx.categoriaSequence.create({
          data: {
            tipo: 'fornecedor',
            base: FornecedoresService.BASE,
            proximo,
            teto: FornecedoresService.TETO,
            seedFonte: 'medido 01/08/2026: fornecedores.CODIGO max 10.526, int(11)',
          },
        });
      }
      return proximo;
    });
  }

  async criar(dto: any, usuario?: string) {
    const razao = this.campo(dto.razaoSocial, 'razaoSocial');
    if (!razao) throw new BadRequestException('Razão social é obrigatória');

    const codigo = await this.proximoCodigo();
    const dados = this.montar(dto, razao);

    const criado = await (this.prisma as any).wincredFornecedor.create({
      data: { codigo, ...dados, dataCadastro: new Date(), flowIsSource: true, gigaOk: false },
    });

    await this.replicar(codigo, usuario);
    this.logger.log(`[fornecedor] ${codigo} "${razao}" criado no Flow${usuario ? ` por ${usuario}` : ''}`);
    return criado;
  }

  async atualizar(codigo: number, dto: any, usuario?: string) {
    await this.buscar(codigo);
    const razao = this.campo(dto.razaoSocial, 'razaoSocial');
    if (!razao) throw new BadRequestException('Razão social é obrigatória');

    const atualizado = await (this.prisma as any).wincredFornecedor.update({
      where: { codigo },
      data: { ...this.montar(dto, razao), editedAt: new Date(), gigaOk: false },
    });

    await this.replicar(codigo, usuario);
    this.logger.log(`[fornecedor] ${codigo} editado${usuario ? ` por ${usuario}` : ''}`);
    return atualizado;
  }

  private montar(dto: any, razao: string) {
    return {
      razaoSocial: razao,
      fantasia: this.campo(dto.fantasia, 'fantasia'),
      // Guarda só os dígitos: é como o resto do sistema compara CNPJ.
      cnpj: this.campo(String(dto.cnpj ?? '').replace(/\D/g, ''), 'cnpj'),
      ie: this.campo(dto.ie, 'ie'),
      endereco: this.campo(dto.endereco, 'endereco'),
      bairro: this.campo(dto.bairro, 'bairro'),
      cidade: this.campo(dto.cidade, 'cidade'),
      uf: this.campo(String(dto.uf ?? '').toUpperCase(), 'uf'),
      ddd: this.campo(String(dto.ddd ?? '').replace(/\D/g, ''), 'ddd'),
      fone: this.campo(dto.fone, 'fone'),
      fax: this.campo(dto.fax, 'fax'),
      cep: this.campo(String(dto.cep ?? '').replace(/\D/g, ''), 'cep'),
      email: this.campo(dto.email, 'email'),
      contato: this.campo(dto.contato, 'contato'),
      // OBS é blob no Giga — grava como bytes pra não quebrar a réplica.
      obs: dto.obs ? Buffer.from(String(dto.obs).slice(0, 500), 'utf8') : null,
    };
  }

  /**
   * Réplica no Giga: tenta inline e cai pra fila. Nunca lança — o fornecedor já
   * existe no Flow e derrubar aqui impediria o cadastro por causa de um banco
   * que é só espelho.
   */
  private async replicar(codigo: number, usuario?: string): Promise<void> {
    try {
      const f = await (this.prisma as any).wincredFornecedor.findUnique({ where: { codigo } });
      await (this.erp as any).replicarFornecedorInline(f);
      await (this.prisma as any).wincredFornecedor.update({
        where: { codigo }, data: { gigaOk: true },
      });
    } catch (e: any) {
      try {
        await (this.prisma as any).erpOutbox.create({
          data: {
            kind: 'fornecedor_upsert',
            saleId: `fornecedor-${codigo}`,
            payload: { codigo, usuario: usuario || null },
            status: 'pending',
          },
        });
        this.logger.warn(`[fornecedor] Giga indisponível (${e?.message}) — ${codigo} vale no Flow, réplica na fila`);
      } catch (e2: any) {
        if (String(e2?.code) === 'P2002') return; // já enfileirado
        this.logger.error(`[fornecedor] ${codigo} criado no Flow mas NÃO enfileirado: ${e2?.message}`);
      }
    }
  }
}
