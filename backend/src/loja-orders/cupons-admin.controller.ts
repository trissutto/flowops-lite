import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CupomService } from './cupom.service';

/**
 * PAINEL "CUPONS" — /retaguarda/cupons (pedido do dono, 01/09).
 *
 * O vale de troca nominal já NASCIA sozinho (portal de trocas, devolução na
 * loja, peça faltante), mas não existia lugar nenhum pra criar um NA MÃO —
 * nem no WooCommerce isso existia. Este controller é a porta do painel:
 *
 *  - vale de troca manual: `origem: 'troca'`, `tipo: 'fixed'`, uso único,
 *    nominal por CPF — o MESMO formato dos automáticos, então vale no site
 *    E no caixa do PDV sem regra nova no caminho do dinheiro.
 *  - cupom de campanha: os mesmos campos da aba de loja-frete.
 *
 * Vive separado do `LojaAdminController` de propósito: aquele arquivo
 * concentra conciliação/frete/escudo e muda com frequência — cupom manual é
 * assunto próprio.
 */
@Controller('admin/cupons')
@UseGuards(JwtAuthGuard)
export class CuponsAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cupons: CupomService,
  ) {}

  private exigirAdmin(req: any): string {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master') throw new ForbiddenException('Apenas admin/master');
    return String(req?.user?.name || req?.user?.username || 'admin');
  }

  private normCode(v: any): string {
    return String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
  }

  /**
   * Código de vale legível por telefone: sem 0/O, 1/I/L — a cliente vai
   * DIGITAR isso no checkout ou ditar no balcão, e "O" vs "0" vira ligação
   * de "seu cupom não funciona".
   */
  private async gerarCodigoVale(): Promise<string | null> {
    const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (let tentativa = 0; tentativa < 6; tentativa++) {
      let sufixo = '';
      for (let i = 0; i < 6; i++) {
        sufixo += alfabeto[Math.floor(Math.random() * alfabeto.length)];
      }
      const code = `VALE${sufixo}`;
      const existe = await (this.prisma as any).siteCupom.findUnique({
        where: { code },
        select: { code: true },
      });
      if (!existe) return code;
    }
    return null;
  }

  @Get()
  async listar(@Req() req: any) {
    this.exigirAdmin(req);
    const itens = await (this.prisma as any).siteCupom
      .findMany({ orderBy: [{ ativo: 'desc' }, { createdAt: 'desc' }] })
      .catch(() => []);
    return { ok: true, itens };
  }

  /**
   * GET /admin/cupons/cliente?cpf= — conferência de "é essa cliente mesmo?"
   * antes de amarrar o vale num CPF. Não achar no CRM NÃO bloqueia: cliente
   * nova de loja pode não ter cadastro ainda — é aviso, nunca trava.
   */
  @Get('cliente')
  async cliente(@Req() req: any, @Query('cpf') cpf?: string) {
    this.exigirAdmin(req);
    const d = String(cpf || '').replace(/\D/g, '');
    if (d.length !== 11) return { ok: false, error: 'CPF precisa ter 11 dígitos.' };
    const fmt = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
    const achado = await (this.prisma as any).customer
      .findFirst({
        where: { cpf: { in: [d, fmt] }, name: { not: null } },
        select: { name: true, whatsapp: true, phone: true },
      })
      .catch(() => null);
    if (!achado) return { ok: true, encontrado: false };
    return {
      ok: true,
      encontrado: true,
      nome: achado.name,
      whatsapp: achado.whatsapp || achado.phone || null,
    };
  }

  /**
   * POST /admin/cupons — cria ou edita.
   *
   * `novo: true` recusa código repetido em vez de sobrescrever: o upsert
   * silencioso da rota antiga transformaria "criei um vale com código que já
   * existia" em "reescrevi o vale de outra cliente" — e isso é dinheiro.
   *
   * Vale de troca (`origem: 'troca'`) tem formato travado: `tipo 'fixed'`,
   * uso único. É o único formato que o PDV aceita como vale, e é o que os
   * caminhos automáticos (portal de trocas, devolução na loja) já gravam.
   */
  @Post()
  async salvar(@Req() req: any, @Body() body: any) {
    const quem = this.exigirAdmin(req);

    const origem = body?.origem === 'troca' ? 'troca' : 'campanha';
    const ehVale = origem === 'troca';

    let code = this.normCode(body?.code);
    if (!code && ehVale) {
      const gerado = await this.gerarCodigoVale();
      if (!gerado) return { ok: false, error: 'Não consegui gerar um código. Tente de novo.' };
      code = gerado;
    }
    if (!code) return { ok: false, error: 'Informe o código do cupom.' };
    if (code.length > 30) return { ok: false, error: 'Código muito longo (máximo 30 caracteres).' };

    const existente = await (this.prisma as any).siteCupom
      .findUnique({ where: { code } })
      .catch(() => null);
    if (body?.novo && existente) {
      return { ok: false, error: `Já existe um cupom com o código ${code}. Use outro código.` };
    }
    // Vale já gasto é HISTÓRICO de dinheiro: reescrever valor/CPF depois do
    // uso deixaria a conciliação sem explicação. Desligar também não — a
    // linha usada é a prova de por que a venda saiu mais barata.
    if (existente?.usadoAt) {
      return { ok: false, error: `O vale ${code} já foi usado — não dá mais pra mexer nele.` };
    }

    const tipo = ehVale ? 'fixed' : ['percent', 'fixed', 'shipping'].includes(body?.tipo) ? body.tipo : 'percent';
    const valor = Number(body?.valor) || 0;
    if (tipo === 'percent' && (valor <= 0 || valor > 90)) {
      return { ok: false, error: 'Percentual precisa ficar entre 1 e 90.' };
    }
    if (tipo === 'fixed' && valor <= 0) {
      return { ok: false, error: ehVale ? 'Informe o valor do vale.' : 'Valor do desconto precisa ser maior que zero.' };
    }

    const cpf = String(body?.cpf || '').replace(/\D/g, '');
    if (cpf && cpf.length !== 11) {
      return { ok: false, error: 'CPF precisa ter 11 dígitos (ou ficar vazio).' };
    }

    const dados = {
      label: String(body?.label || (ehVale ? 'Vale de troca' : code)).trim().slice(0, 80),
      tipo,
      valor,
      minSubtotal: body?.minSubtotal == null || body.minSubtotal === '' ? null : Number(body.minSubtotal),
      primeiraCompra: ehVale ? false : !!body?.primeiraCompra,
      categorias: ehVale ? null : String(body?.categorias || '').trim().toLowerCase().slice(0, 300) || null,
      inicioEm: body?.inicioEm ? new Date(body.inicioEm) : null,
      fimEm: body?.fimEm ? new Date(body.fimEm) : null,
      // Vale é uso único SEMPRE — é crédito, não campanha.
      usoMaximo: ehVale ? 1 : body?.usoMaximo == null || body.usoMaximo === '' ? null : Number(body.usoMaximo),
      ativo: body?.ativo === undefined ? true : !!body.ativo,
      cpf: cpf || null,
      origem,
      atualizadoPor: quem,
    };

    const salvo = await (this.prisma as any).siteCupom.upsert({
      where: { code },
      update: dados,
      create: { code, ...dados },
    });

    // Sem isto o cupom só valeria depois do TTL de 60s — e o vale manual é
    // criado com a cliente NA LINHA esperando o código pra usar.
    this.cupons.invalidarCache();
    return { ok: true, cupom: salvo };
  }

  /** Desativa (nunca apaga — cupom usado é a explicação do pedido barato). */
  @Delete(':code')
  async desligar(@Req() req: any, @Param('code') code: string) {
    const quem = this.exigirAdmin(req);
    const c = this.normCode(code);
    const existente = await (this.prisma as any).siteCupom
      .findUnique({ where: { code: c }, select: { usadoAt: true } })
      .catch(() => null);
    if (existente?.usadoAt) {
      return { ok: false, error: 'Esse vale já foi usado — a linha fica como registro.' };
    }
    await (this.prisma as any).siteCupom
      .update({ where: { code: c }, data: { ativo: false, atualizadoPor: quem } })
      .catch(() => undefined);
    this.cupons.invalidarCache();
    return { ok: true };
  }
}
