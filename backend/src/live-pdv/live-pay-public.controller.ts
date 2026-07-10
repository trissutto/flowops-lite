import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { LivePdvService } from './live-pdv.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Controller PÚBLICO (SEM JwtAuthGuard) — página de fechamento da cliente.
 *
 * A apresentadora manda o link /pagar/<cartId> pra cliente. Ela informa o CEP
 * (calcula frete), escolhe PIX (PagBank) ou cartão até 12x sem juros (link
 * Pagar.me) e paga. A confirmação é automática (mesmo cron/webhook da live).
 *
 * Segurança: o cartId é um UUID (não adivinhável) e o único dado sensível
 * exposto é o primeiro nome + itens + total. Nada de CPF/telefone/custo.
 */
@Controller('public/live-pay')
export class LivePayPublicController {
  constructor(
    private readonly svc: LivePdvService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Rate limit dos resolvedores (@ e celular são chaves adivinháveis;
  // sem isso dá pra enumerar os @ dos comentários da live). In-memory por
  // IP: 10 tentativas / 5 min. Reinício do processo zera — aceitável.
  private static readonly RL_WINDOW_MS = 5 * 60_000;
  private static readonly RL_MAX = 10;
  private readonly rlHits = new Map<string, { n: number; resetAt: number }>();

  private throttleResolve(req: any): void {
    const ip =
      String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
      String(req?.ip || 'desconhecido');
    const now = Date.now();
    // Faxina ocasional pra Map não crescer sem limite
    if (this.rlHits.size > 5000) {
      for (const [k, v] of this.rlHits) if (v.resetAt < now) this.rlHits.delete(k);
    }
    const cur = this.rlHits.get(ip);
    if (!cur || cur.resetAt < now) {
      this.rlHits.set(ip, { n: 1, resetAt: now + LivePayPublicController.RL_WINDOW_MS });
      return;
    }
    cur.n += 1;
    if (cur.n > LivePayPublicController.RL_MAX) {
      throw new HttpException('Muitas tentativas. Espera uns minutinhos e tenta de novo 💜', 429);
    }
  }

  // LINK MÁGICO: resolve o @ da cliente pro carrinho dela na LIVE ATIVA.
  // Se o carrinho já tem celular, devolve challenge:'tel4' em vez do código
  // (o @ é público nos comentários — os 4 dígitos provam que é a dona).
  // (Declarado ANTES do :cartId pra rota específica ganhar do coringa.)
  @Get('resolve-ig/:ig')
  resolveByIg(@Param('ig') ig: string, @Req() req: any) {
    this.throttleResolve(req);
    return this.svc.resolveCartByIg(ig);
  }

  // Etapa 2 do desafio: 4 últimos dígitos do celular → código do checkout.
  @Post('resolve-ig/:ig/verify')
  verifyIg(@Param('ig') ig: string, @Body() body: { last4?: string }, @Req() req: any) {
    this.throttleResolve(req);
    return this.svc.verifyCartByIg(ig, String(body?.last4 || ''));
  }

  // Chave alternativa: CELULAR completo (só a dona sabe — abre direto).
  @Get('resolve-tel/:tel')
  resolveByTel(@Param('tel') tel: string, @Req() req: any) {
    this.throttleResolve(req);
    return this.svc.resolveCartByPhone(tel);
  }

  // O :cartId aceita o UUID antigo OU o payCode curto (/p/<code>).
  @Get(':cartId')
  async summary(@Param('cartId') key: string) {
    const cartId = await this.svc.resolvePublicCartId(key);
    return this.svc.publicCheckoutSummary(cartId);
  }

  @Get(':cartId/status')
  async status(@Param('cartId') key: string) {
    const cartId = await this.svc.resolvePublicCartId(key);
    const r: any = await this.svc.checkPayment(cartId);
    return { paid: !!r?.paid };
  }

  @Post(':cartId/frete')
  async frete(@Param('cartId') key: string, @Body() body: { cep?: string }) {
    const digits = String(body?.cep || '').replace(/\D/g, '');
    if (digits.length !== 8) {
      throw new BadRequestException('CEP inválido. Digite os 8 números.');
    }
    const cartId = await this.svc.resolvePublicCartId(key);
    return this.svc.computeFreteFromCep(cartId, digits);
  }

  // RETIRADA EM LOJA — frete zero, prazo de até 7 dias úteis (igual ao site)
  @Post(':cartId/retirada')
  async retirada(@Param('cartId') key: string, @Body() body: { storeCode?: string }) {
    if (!String(body?.storeCode || '').trim()) {
      throw new BadRequestException('Escolha a loja de retirada.');
    }
    const cartId = await this.svc.resolvePublicCartId(key);
    return this.svc.setPublicPickup(cartId, String(body.storeCode).trim());
  }

  // Endereço + dados de contato — a cliente preenche NO checkout (a loja
  // recebe o pedido pronto pra postar, sem caçar dados pelo Direct).
  // Celular é OBRIGATÓRIO pra pagar (validado aqui e no guardPayable);
  // CPF/e-mail são opcionais mas validados quando enviados.
  @Post(':cartId/endereco')
  async endereco(
    @Param('cartId') key: string,
    @Body()
    body: {
      nome?: string;
      endereco?: string;
      numero?: string;
      complemento?: string;
      bairro?: string;
      cidade?: string;
      uf?: string;
      celular?: string;
      cpf?: string;
      email?: string;
    },
  ) {
    const cartId = await this.svc.resolvePublicCartId(key);
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Compra não encontrada');
    const clean = (v: any, max: number) => String(v || '').trim().slice(0, max);
    const data: any = {};
    // Nome completo da destinatária — a loja posta a encomenda no nome dela,
    // não no @ do Instagram (que era o que sobrava no pedido). Só sobrescreve
    // se a cliente digitou um nome (nunca apaga um nome já existente).
    const nome = clean(body?.nome, 80);
    if (nome) data.customerName = nome;
    // "Entregar neste endereço": o front não reenvia o endereço salvo (a
    // página pública só mostra ele mascarado). Se nenhum campo de endereço
    // veio E o carrinho já tem endereço completo, mantém o que está no banco.
    const enderecoEnviado = [body?.endereco, body?.numero, body?.cidade, body?.uf]
      .some((v) => String(v || '').trim());
    const jaTemEndereco = !!(
      String(cart.customerEndereco || '').trim() &&
      String(cart.customerNumero || '').trim() &&
      String(cart.customerCidade || '').trim() &&
      String(cart.customerUf || '').trim()
    );
    // Endereço: obrigatório só no modo ENTREGA (retirada em loja dispensa)
    if (!cart.isPickup && (enderecoEnviado || !jaTemEndereco)) {
      data.customerEndereco = clean(body?.endereco, 160);
      data.customerNumero = clean(body?.numero, 20);
      data.customerComplemento = clean(body?.complemento, 80);
      data.customerBairro = clean(body?.bairro, 80);
      data.customerCidade = clean(body?.cidade, 80);
      data.customerUf = clean(body?.uf, 2).toUpperCase();
      const faltando: string[] = [];
      if (!data.customerEndereco) faltando.push('rua');
      if (!data.customerNumero) faltando.push('número');
      if (!data.customerCidade) faltando.push('cidade');
      if (data.customerUf.length !== 2) faltando.push('UF');
      if (faltando.length) {
        throw new BadRequestException(`Preencha o endereço de entrega — falta: ${faltando.join(', ')}.`);
      }
    }

    // Celular: obrigatório se o carrinho ainda não tem um válido
    const jaTemFone = String(cart.customerPhone || '').replace(/\D/g, '').length >= 10;
    const celDigits = String(body?.celular || '').replace(/\D/g, '');
    if (celDigits) {
      if (celDigits.length < 10 || celDigits.length > 11) {
        throw new BadRequestException('Celular inválido. Use DDD + número (ex.: 11 91234-5678).');
      }
      data.customerPhone = celDigits;
    } else if (!jaTemFone) {
      throw new BadRequestException('Informe seu celular (com DDD) pra gente falar com você sobre a entrega.');
    }
    // CPF/e-mail: opcionais, mas validados quando preenchidos
    const cpfDigits = String(body?.cpf || '').replace(/\D/g, '');
    if (cpfDigits) {
      if (cpfDigits.length !== 11) throw new BadRequestException('CPF inválido — são 11 números.');
      data.customerCpf = cpfDigits;
    }
    const email = clean(body?.email, 120);
    if (email) {
      if (!/\S@\S+\.\S+/.test(email)) throw new BadRequestException('E-mail inválido.');
      data.customerEmail = email;
    }

    await (this.prisma as any).livePdvCart.update({ where: { id: cartId }, data });
    return { ok: true };
  }

  @Post(':cartId/pix')
  async pix(@Param('cartId') key: string) {
    const cartId = await this.svc.resolvePublicCartId(key);
    await this.guardPayable(cartId);
    return this.svc.startPayment(cartId);
  }

  @Post(':cartId/card')
  async card(@Param('cartId') key: string) {
    const cartId = await this.svc.resolvePublicCartId(key);
    await this.guardPayable(cartId);
    return this.svc.startPaymentLink(cartId);
  }

  /**
   * Só deixa cobrar se: existe, não está pago, celular preenchido e —
   * ENTREGA: CEP + endereço completo (loja posta) · RETIRADA: loja escolhida.
   */
  private async guardPayable(cartId: string): Promise<void> {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Compra não encontrada');
    if (LivePdvService.PAID_STATES.includes(cart.status)) {
      throw new BadRequestException('Essa compra já foi paga. 💜');
    }
    if (cart.isPickup) {
      if (!String(cart.pickupStoreCode || '').trim()) {
        throw new BadRequestException('Escolha a loja de retirada antes de pagar. 💜');
      }
    } else {
      const cep = String(cart.customerCep || '').replace(/\D/g, '');
      if (cep.length !== 8) {
        throw new BadRequestException('Informe seu CEP pra calcular o frete antes de pagar.');
      }
      if (
        !String(cart.customerEndereco || '').trim() ||
        !String(cart.customerNumero || '').trim() ||
        !String(cart.customerCidade || '').trim() ||
        !String(cart.customerUf || '').trim()
      ) {
        throw new BadRequestException('Preencha o endereço de entrega antes de pagar. 💜');
      }
    }
    if (String(cart.customerPhone || '').replace(/\D/g, '').length < 10) {
      throw new BadRequestException('Informe seu celular (com DDD) antes de pagar. 💜');
    }
    // Nome completo obrigatório: sem ele a loja não tem em nome de quem postar.
    // "Real" = tem nome + sobrenome e não é só o @ do Instagram.
    const nome = String(cart.customerName || '').trim();
    const igHandle = String(cart.customerInstagram || '').replace(/^@/, '').trim().toLowerCase();
    const nomeOk = nome.length >= 3 && /\s/.test(nome) && nome.toLowerCase() !== igHandle;
    if (!nomeOk) {
      throw new BadRequestException('Informe seu nome completo (nome e sobrenome) pra gente postar seu pedido. 💜');
    }
  }
}
