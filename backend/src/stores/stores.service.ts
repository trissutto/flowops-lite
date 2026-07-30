import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface StoreInput {
  code?: string;
  name?: string;
  cep?: string;
  city?: string;
  state?: string;
  whatsapp?: string;
  contactName?: string;
  active?: boolean;
  priorityScore?: number;
  /**
   * REDE   = loja própria (sem cobrança intercompany entre si)
   * FILIAL = franquia (paga preço/2.5 + 8% royalties + 4% marketing)
   * Default: REDE.
   */
  tipo?: 'REDE' | 'FILIAL';
  /**
   * CNPJ esperado pra essa loja emitir NFC-e. Quando o grupo tem múltiplas
   * empresas (ex: SOROCABA emite por T.O. RISSUTTO, demais por LURDS PLUS SIZE),
   * cadastrar aqui o CNPJ correto evita que a loja emita pela empresa errada.
   * Validação: PDV bloqueia finalize se config.cnpj não bater.
   */
  expectedCnpj?: string | null;
  expectedRazaoSocial?: string | null;
  /**
   * Score (0-200) que define o "peso" da loja como destino quando o sistema
   * CONSOLIDA peças fragmentadas (Sprint 3). Maior = mais ímã pra concentrar
   * grades. Default 50 (neutro). Use 100+ pra lojas-âncora.
   */
  consolidationScore?: number;
  /**
   * Marca a loja como destino preferencial de peças OUTLET (cadastro antigo,
   * baixo giro). Quando true, peças velhas vão pra essa loja.
   */
  isOutlet?: boolean;
  /**
   * Gateway PIX da loja: 'auto' (default — tenta PagBank, fallback Pagar.me),
   * 'pagbank' (forca PagBank), 'pagarme' (forca Pagar.me).
   * Em todos: cai pro PIX local se gateway falhar.
   *
   * 'externo' = loja SEM integração de gateway (ex.: franquias sem chave
   * Pagar.me). O PIX vira só "informar pagamento": no PDV finaliza direto como
   * dinheiro/cartão (cliente paga na maquininha própria da loja); na Live o
   * carrinho é confirmado manualmente (POST /live-pdv/carts/:id/pay-external).
   * NUNCA chama Pagar.me/PagBank.
   */
  pixProvider?: 'auto' | 'pagbank' | 'pagarme' | 'externo';
  /**
   * Provedor de ENVIO da loja no "Gerar envio" da separação:
   *   'correios' (default) ou 'maisenvios'. Quando maisenvios,
   *   `maisEnviosSenderId` é o id do remetente da loja no portal Mais Envios.
   */
  shippingProvider?: 'correios' | 'maisenvios' | null;
  maisEnviosSenderId?: number | null;
}

@Injectable()
export class StoresService implements OnModuleInit {
  private readonly logger = new Logger(StoresService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * NOMES OFICIAIS DAS LOJAS (dono 30/07). Aplica no boot, uma vez:
   *   01 → MATRIZ T.O.      (era ITANHAÉM)
   *   09 → MATRIZ LURDS     (era SANTOS 2 — mudou de Santos pra Itanhaém;
   *                          nem estava no cadastro do Flow, só no Giga)
   *   20 → PESSOA FISICA    (era DEPOSITO — contas particulares do dono)
   *
   * IDEMPOTENTE e RESPEITOSO: só renomeia se o nome atual ainda for um dos
   * ANTIGOS. Se alguém renomear depois pela tela, o boot não desfaz.
   * O nome anterior vai pra `nomesAntigos` (histórico de venda que gravou o
   * nome em storeCode continua casando — ver faturamento.service).
   */
  private static readonly NOMES_OFICIAIS = [
    { code: '01', antigos: ['ITANHAEM', 'ITANHAÉM'], nome: 'MATRIZ T.O.' },
    { code: '09', antigos: ['SANTOS 2', 'SANTOS2', 'SANTOS II'], nome: 'MATRIZ LURDS', criarSeFaltar: true },
    { code: '20', antigos: ['DEPOSITO', 'DEPÓSITO', 'PF'], nome: 'PESSOA FISICA' },
  ];

  async onModuleInit() {
    try {
      for (const alvo of StoresService.NOMES_OFICIAIS) {
        const atual = await this.prisma.store.findUnique({ where: { code: alvo.code } });

        if (!atual) {
          if (!alvo.criarSeFaltar) continue;
          // Centro de custo que só existia no Giga: entra INATIVA de propósito
          // — aparece no Contas a Pagar (whitelist própria) sem virar loja
          // fantasma no PDV/faturamento, que filtram por active=true.
          await this.prisma.store.create({
            data: { code: alvo.code, name: alvo.nome, active: false, tipo: 'REDE' } as any,
          });
          this.logger.log(`[stores] loja ${alvo.code} criada como "${alvo.nome}" (inativa — centro de custo)`);
          continue;
        }

        const nomeAtual = String(atual.name || '').trim().toUpperCase();
        if (nomeAtual === alvo.nome.toUpperCase()) continue;           // já está certo
        if (!alvo.antigos.some((a) => a.toUpperCase() === nomeAtual)) continue; // renomeada à mão: não mexe

        const antigos = String((atual as any).nomesAntigos || '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        if (!antigos.some((n) => n.toUpperCase() === nomeAtual)) antigos.push(atual.name);

        await this.prisma.store.update({
          where: { code: alvo.code },
          data: { name: alvo.nome, nomesAntigos: antigos.join(',').slice(0, 300) } as any,
        });
        this.logger.log(`[stores] loja ${alvo.code}: "${atual.name}" → "${alvo.nome}" (histórico preservado)`);
      }
    } catch (e) {
      // Nome de loja não pode derrubar o boot do backend.
      this.logger.warn(`[stores] nomes oficiais não aplicados: ${(e as Error).message}`);
    }
  }

  list() {
    return this.prisma.store.findMany({ orderBy: { code: 'asc' } });
  }

  /**
   * Retorna config do gateway PIX da loja. Default 'auto' se nunca configurada.
   * Usada pelo PDV antes de gerar QR Code pra escolher qual gateway tentar.
   */
  async getPixProvider(
    code: string,
  ): Promise<{ provider: 'auto' | 'pagbank' | 'pagarme' | 'externo' }> {
    const store = await this.prisma.store.findUnique({
      where: { code },
      select: { pixProvider: true } as any,
    });
    const p = (store as any)?.pixProvider || 'auto';
    if (p === 'pagbank' || p === 'pagarme' || p === 'externo') return { provider: p };
    return { provider: 'auto' };
  }

  /**
   * Define o gateway PIX da loja (por CODIGO). Usado pelo painel de config
   * por loja pra escolher PagBank x Pagar.me sem precisar do id (UUID).
   */
  async setPixProvider(
    code: string,
    provider: 'auto' | 'pagbank' | 'pagarme' | 'externo',
  ): Promise<{ provider: 'auto' | 'pagbank' | 'pagarme' | 'externo' }> {
    const p = ['auto', 'pagbank', 'pagarme', 'externo'].includes(provider) ? provider : 'auto';
    await this.prisma.store.update({
      where: { code },
      data: { pixProvider: p } as any,
    });
    return { provider: p };
  }

  /**
   * Lista lojas com config de realinhamento (campos canSendRealign + canReceiveRealign).
   * Usado pela aba Config da tela de Distribuição de Estoque.
   */
  async listRealignConfig() {
    const stores = await this.prisma.store.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      select: {
        code: true,
        name: true,
        city: true,
        tipo: true,
        priorityScore: true,
        canSendRealign: true,
        canReceiveRealign: true,
        consolidationScore: true,
        isOutlet: true,
      } as any,
    });
    return stores;
  }

  /**
   * Atualiza config de realinhamento em batch (vários toggles de uma vez).
   * Atomicidade: tudo numa transaction — se um item falhar, rollback total.
   */
  async updateRealignConfig(
    items: Array<{
      code: string;
      canSendRealign: boolean;
      canReceiveRealign: boolean;
      consolidationScore?: number;
      isOutlet?: boolean;
    }>,
  ) {
    if (!Array.isArray(items) || items.length === 0) {
      return { updated: 0 };
    }
    const ops = items.map((it) =>
      this.prisma.store.update({
        where: { code: it.code },
        data: {
          canSendRealign: !!it.canSendRealign,
          canReceiveRealign: !!it.canReceiveRealign,
          // Campos Sprint 0 — só atualiza se vieram no payload (undefined = não mexe)
          ...(it.consolidationScore !== undefined
            ? { consolidationScore: Math.max(0, Math.min(200, Number(it.consolidationScore) || 50)) }
            : {}),
          ...(it.isOutlet !== undefined ? { isOutlet: !!it.isOutlet } : {}),
        } as any,
      }),
    );
    await this.prisma.$transaction(ops);
    return { updated: items.length };
  }

  async performance(storeId: string) {
    const [total, separating, shipped] = await this.prisma.$transaction([
      this.prisma.pickOrder.count({ where: { storeId } }),
      this.prisma.pickOrder.count({ where: { storeId, status: 'separating' } }),
      this.prisma.pickOrder.count({ where: { storeId, status: 'shipped' } }),
    ]);
    return { total, separating, shipped };
  }

  async create(data: StoreInput) {
    if (!data.code?.trim()) throw new BadRequestException('Código é obrigatório');
    if (!data.name?.trim()) throw new BadRequestException('Nome é obrigatório');

    const code = data.code.trim();
    const exists = await this.prisma.store.findUnique({ where: { code } });
    if (exists) throw new ConflictException(`Já existe uma loja com o código "${code}"`);

    return this.prisma.store.create({
      data: {
        code,
        name: data.name.trim(),
        cep: data.cep?.trim() || null,
        city: data.city?.trim() || null,
        state: data.state?.trim().toUpperCase() || null,
        whatsapp: this.cleanPhone(data.whatsapp),
        contactName: data.contactName?.trim() || null,
        active: data.active ?? true,
        priorityScore: data.priorityScore ?? 50,
        tipo: data.tipo === 'FILIAL' ? 'FILIAL' : 'REDE',
        expectedCnpj: this.cleanCnpj(data.expectedCnpj),
        expectedRazaoSocial: data.expectedRazaoSocial?.trim() || null,
        consolidationScore: data.consolidationScore !== undefined
          ? Math.max(0, Math.min(200, Number(data.consolidationScore) || 50))
          : 50,
        isOutlet: data.isOutlet ?? false,
      } as any,
    });
  }

  /** Strip não-dígitos do CNPJ. Retorna null se vazio. */
  private cleanCnpj(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    return digits || null;
  }

  async update(id: string, data: StoreInput) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Loja não encontrada');

    // Se tentou trocar o código, confere se não conflita
    if (data.code && data.code.trim() !== store.code) {
      const conflict = await this.prisma.store.findUnique({ where: { code: data.code.trim() } });
      if (conflict) throw new ConflictException(`Já existe uma loja com o código "${data.code}"`);
    }

    // RENOMEAR SEM PERDER HISTÓRICO (30/07): venda antiga podia gravar o NOME
    // da loja em PdvSale.storeCode. Guardando o nome anterior, os relatórios
    // que casam por [code, name] continuam achando o histórico depois que a
    // loja troca de nome (ex.: 09 "SANTOS 2" → "MATRIZ LURDS").
    let nomesAntigos: string | undefined;
    const novoNome = data.name?.trim();
    if (novoNome && novoNome !== store.name) {
      const antigos = String((store as any).nomesAntigos || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!antigos.some((n) => n.toUpperCase() === store.name.toUpperCase())) {
        antigos.push(store.name);
      }
      nomesAntigos = antigos.join(',').slice(0, 300);
      this.logger.log(
        `[stores] loja ${store.code} renomeada "${store.name}" → "${novoNome}" (histórico preservado: ${nomesAntigos})`,
      );
    }

    return this.prisma.store.update({
      where: { id },
      data: {
        code: data.code?.trim() ?? undefined,
        name: novoNome ?? undefined,
        nomesAntigos,
        cep: data.cep !== undefined ? (data.cep.trim() || null) : undefined,
        city: data.city !== undefined ? (data.city.trim() || null) : undefined,
        state: data.state !== undefined ? (data.state.trim().toUpperCase() || null) : undefined,
        whatsapp: data.whatsapp !== undefined ? this.cleanPhone(data.whatsapp) : undefined,
        contactName: data.contactName !== undefined ? (data.contactName.trim() || null) : undefined,
        active: data.active ?? undefined,
        priorityScore: data.priorityScore ?? undefined,
        tipo: data.tipo ? (data.tipo === 'FILIAL' ? 'FILIAL' : 'REDE') : undefined,
        expectedCnpj: data.expectedCnpj !== undefined ? this.cleanCnpj(data.expectedCnpj) : undefined,
        expectedRazaoSocial: data.expectedRazaoSocial !== undefined
          ? (data.expectedRazaoSocial?.trim() || null)
          : undefined,
        consolidationScore: data.consolidationScore !== undefined
          ? Math.max(0, Math.min(200, Number(data.consolidationScore) || 50))
          : undefined,
        isOutlet: data.isOutlet !== undefined ? !!data.isOutlet : undefined,
        pixProvider: data.pixProvider && ['auto', 'pagbank', 'pagarme', 'externo'].includes(data.pixProvider)
          ? data.pixProvider
          : undefined,
        shippingProvider: data.shippingProvider !== undefined
          ? (data.shippingProvider === 'maisenvios' ? 'maisenvios' : 'correios')
          : undefined,
        maisEnviosSenderId: data.maisEnviosSenderId !== undefined
          ? (data.maisEnviosSenderId ? Number(data.maisEnviosSenderId) : null)
          : undefined,
      } as any,
    });
  }

  /**
   * Remove a loja. Se tiver vínculos (pedidos, separações, usuários) faz SOFT DELETE
   * (só desativa, preserva histórico). Senão, hard delete.
   */
  async remove(id: string) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Loja não encontrada');

    const [orderItems, pickOrders, users] = await Promise.all([
      this.prisma.orderItem.count({ where: { assignedStoreId: id } }),
      this.prisma.pickOrder.count({ where: { storeId: id } }),
      this.prisma.user.count({ where: { storeId: id } }),
    ]);
    const links = orderItems + pickOrders + users;

    if (links > 0) {
      await this.prisma.store.update({ where: { id }, data: { active: false } });
      return { deleted: false, deactivated: true, reason: `Loja tem ${links} vínculo(s) (pedidos/separações/usuários), apenas desativada.` };
    }

    await this.prisma.store.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }

  private cleanPhone(v: string | undefined | null): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const clean = v.replace(/\D/g, '');
    return clean.length ? clean : null;
  }
}
