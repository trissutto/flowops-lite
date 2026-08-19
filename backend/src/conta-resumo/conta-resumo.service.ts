import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { situacaoPublica } from '../common/situacao-pedido';
import { AvaliacoesService } from '../avaliacoes/avaliacoes.service';

/** Um bloco da barra: o que está pendente e quantos. */
export interface BlocoDaConta {
  chave: 'a_pagar' | 'preparando' | 'a_caminho' | 'avaliar' | 'trocas';
  rotulo: string;
  quantidade: number;
}

/**
 * A BARRA DE "MINHA CONTA" — o que a cliente tem em aberto, em cinco números.
 *
 * A conta era um menu: seis cards iguais, nenhum dizendo se havia algo
 * esperando por ela. A barra inverte isso — quem abre vê primeiro o que está
 * PARADO (pagamento não feito, peça a caminho, avaliação esperando) e só
 * depois o menu.
 *
 * É a mesma diretriz da fila da loja (`/minha-loja`): tarefa clicável antes de
 * menu. E vale aqui a mesma regra de ouro — **contador só conta pendência
 * real**. Bolinha que aparece sem motivo ensina a cliente a ignorar a barra
 * inteira, inclusive no dia em que ela importa.
 */
@Injectable()
export class ContaResumoService {
  private readonly logger = new Logger(ContaResumoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly avaliacoes: AvaliacoesService,
  ) {}

  async resumo(accountId: string): Promise<{ blocos: BlocoDaConta[]; total: number }> {
    const acc = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { cpf: true },
    });
    if (!acc) throw new UnauthorizedException('Conta não encontrada');

    const [pedidos, trocas, aAvaliar] = await Promise.all([
      this.prisma.order.findMany({
        where: { customerCpf: acc.cpf },
        orderBy: { wcDateCreated: 'desc' },
        take: 100,
        select: { status: true, paidAt: true, trackingCode: true, wcDateCreated: true },
      }),
      // Troca em andamento é tarefa aberta: a peça está com a cliente ou no
      // caminho de volta, e ela quer saber onde parou.
      (this.prisma as any).trocaSolicitacao
        .count({
          where: {
            customerCpf: acc.cpf,
            status: { notIn: ['finalizada', 'cancelada'] },
          },
        })
        .catch(() => 0),
      this.avaliacoes.contarPendentes(accountId),
    ]);

    /**
     * CONTADOR SÓ CONTA O QUE AINDA É PENDÊNCIA DE VERDADE.
     *
     * Sem janela, dois lixos entrariam na barra e ficariam pra sempre:
     * o PIX de março que ninguém pagou (e cujo código venceu em 24h) viraria
     * um "A pagar 1" eterno, e o pedido cuja entrega o rastreio nunca
     * confirmou — a maioria das etiquetas não é do nosso contrato — ficaria
     * marcado como "A caminho" meses depois de chegar.
     *
     * Um selo vermelho que a cliente não consegue zerar ensina ela a ignorar
     * a barra inteira. É a mesma regra de ouro da fila da loja.
     */
    const dentroDe = (dias: number, data: Date | null) =>
      !!data && Date.now() - data.getTime() <= dias * 24 * 60 * 60 * 1000;

    /** Pix vence em horas e link de pagamento em 72h — depois disso é pedido morto. */
    const JANELA_A_PAGAR = 7;
    /** Pedido em trânsito há mais de 3 meses não é tarefa: é caso pro atendimento. */
    const JANELA_EM_ANDAMENTO = 90;

    const porChave = (chave: string, dias: number) =>
      pedidos.filter((p) => situacaoPublica(p).chave === chave && dentroDe(dias, p.wcDateCreated))
        .length;

    const blocos: BlocoDaConta[] = [
      {
        chave: 'a_pagar',
        rotulo: 'A pagar',
        quantidade: porChave('aguardando_pagamento', JANELA_A_PAGAR),
      },
      {
        chave: 'preparando',
        rotulo: 'Preparando',
        quantidade: porChave('preparando', JANELA_EM_ANDAMENTO),
      },
      {
        chave: 'a_caminho',
        rotulo: 'A caminho',
        quantidade: porChave('enviado', JANELA_EM_ANDAMENTO),
      },
      { chave: 'avaliar', rotulo: 'Avaliar', quantidade: aAvaliar },
      { chave: 'trocas', rotulo: 'Trocas', quantidade: trocas },
    ];

    return { blocos, total: blocos.reduce((s, b) => s + b.quantidade, 0) };
  }
}
