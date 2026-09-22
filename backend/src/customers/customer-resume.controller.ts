import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CashbackService } from '../cashback/cashback.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { findAllCustomersByCpf, aggregatePerson } from './customer-aggregation.helper';

/**
 * /pdv/customer-resume — ficha do cliente pra PDV. Agregado POR PESSOA
 * (todos os Customers com mesmo CPF/personKey).
 *
 * ── O CASHBACK MUDOU DE FONTE EM 22/09/2026 ──
 *
 * Esta tela anunciava pra vendedora "pode usar R$ X de cashback, até 30% da
 * compra" lendo `cashback_balances` (o saldo por ficha do CRM). Só que não
 * existia botão nenhum que gastasse aquele saldo: a rota de resgate existia e
 * nenhum lugar do frontend a chamava. A vendedora repetia a promessa pra
 * cliente e o caixa não tinha onde aplicar.
 *
 * Agora lê `cashback_creditos` — o mesmo ledger (chave = CPF) que o site e o
 * app mostram e que o `addPayment` do PDV consome com `method: 'cashback'`.
 * Uma fonte, uma porta: o número que aparece aqui é o que o caixa aceita.
 *
 * O saldo já vem com carência e validade aplicadas, então "disponível" aqui
 * quer dizer disponível AGORA — `aLiberar` é separado, porque a cliente
 * pergunta e a vendedora precisa saber responder "libera dia tal".
 */
@Controller('pdv')
@UseGuards(JwtAuthGuard)
export class CustomerResumeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashback: CashbackService,
  ) {}

  @Get('customer-resume')
  async resume(@Query('cpf') cpf: string, @Req() req: any) {
    if (!cpf) return { found: false, message: 'CPF nao informado' };
    const digits = String(cpf).replace(/\D/g, '');
    if (digits.length !== 11) return { found: false, message: 'CPF invalido' };

    const storeId = req?.user?.storeId || null;
    const customers = await findAllCustomersByCpf(this.prisma, digits);
    const [cashbackCfg, saldo] = await Promise.all([
      this.cashback.config(),
      this.cashback.saldo(digits),
    ]);

    if (customers.length === 0) {
      /**
       * Cliente fora do CRM PODE ter cashback: a chave é o CPF, não a ficha.
       * Quem comprou no site sem cadastro de loja cai aqui — devolver o saldo
       * junto evita a vendedora dizer "você não tem nada" pra quem tem.
       */
      return {
        found: false,
        message: 'Cliente nao encontrado no CRM',
        cashbackConfig: cashbackCfg,
        cashback: saldo,
      };
    }

    const agg = aggregatePerson(customers, storeId);
    const c = agg.primary;

    // ENDEREÇO (01/08/2026) — a vendedora redigitava a cada venda.
    //
    // O modal do PDV só lia da VENDA, e venda nova nasce em branco. Como o
    // endereço agora sobe pra ficha da pessoa, é daqui que ele volta: a
    // atendente digita uma vez e o sistema oferece nas próximas, em qualquer
    // loja. Sem isso o cadastro único guarda o dado e não o devolve, que é
    // metade do problema resolvido.
    //
    // Procura entre TODOS os cadastros da pessoa (ela pode ter endereço numa
    // loja e não noutra), preferindo o marcado como principal.
    const enderecos = customers
      .flatMap((x: any) => x.addresses || [])
      .filter((a: any) => a && a.active !== false);
    const end =
      enderecos.find((a: any) => a.isPrimary) || enderecos[0] || null;

    return {
      found: true,
      customer: {
        id: c.id,
        name: c.name,
        cpf: c.cpf,
        whatsapp: c.whatsapp,
        email: c.email,
        endereco: end
          ? {
              cep: end.cep || null,
              logradouro: end.street || null,
              numero: end.number || null,
              complemento: end.complement || null,
              bairro: end.district || null,
              cidade: end.city || null,
              uf: end.state || null,
            }
          : null,
        vipTier: agg.vipTier,
        ltvCents: agg.ltvCents,
        orderCount: agg.orderCount,
        ticketMedioCents: agg.ticketMedioCents,
        firstOrderAt: agg.firstOrderAt,
        lastOrderAt: agg.lastOrderAt,
        originSource: c.originSource,
        bloqueado: customers.some((x) => x.bloqueadoGiga),
        negativado: customers.some((x) => x.negativadoGiga),
        // Centavos: o formato que a tela do PDV já consome. O valor é o do
        // ledger único, não mais o do saldo por ficha do CRM.
        cashbackBalanceCents: Math.round(saldo.disponivel * 100),
        cashbackExpiraEm: saldo.proximaExpiracao,
        cashbackALiberarCents: Math.round(saldo.aLiberar * 100),
        cashbackLiberaEm: saldo.liberaEm,
        cadastrosEm: customers.map((x) => x.originStore?.name).filter(Boolean),
        // Origem do cadastro primário — pra tela avisar "cliente do SITE" /
        // "cliente da loja X" e a vendedora NÃO recadastrar. daLojaAtual=true
        // quando a pessoa tem cadastro na loja que está consultando.
        origem: {
          source: c.originSource || null,
          storeCode: c.originStore?.code || null,
          storeName: c.originStore?.name || null,
          daLojaAtual: !!storeId && c.originStoreId === storeId,
        },
      },
      cashbackConfig: cashbackCfg,
      cashback: saldo,
    };
  }

  /**
   * ⚰️ A ROTA DE RESGATE SAIU DAQUI EM 22/09/2026.
   *
   * `POST /pdv/sales/:saleId/cashback-redeem` debitava `cashback_balances` e
   * gravava um `pdvSalePayment method='cashback'` por fora do fluxo de
   * pagamento do PDV. Nunca teve chamador — nenhuma tela do frontend a
   * conhecia — e, se tivesse, teria furado o caixa e a NFC-e: o método
   * 'cashback' não era tratado em `cash.service` nem em `nfce.service`, então
   * a venda sairia com nota cheia sobre dinheiro que a cliente não pagou.
   *
   * O resgate agora é UM só: `addPayment` com `method: 'cashback'`, que valida
   * pela régua do servidor, consome `cashback_creditos` em FIFO, devolve no
   * `removePayment` e entra na nota como desconto — igual ao vale-troca.
   */
}
