import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';

/**
 * O CPF DOS PEDIDOS ANTIGOS, PELA API REST DO WOOCOMMERCE.
 *
 * ── POR QUE NÃO PELO BANCO ──
 *
 * O caminho óbvio era o MySQL do WordPress. Diagnosticado em 11/08/2026: o
 * Railway responde `EHOSTUNREACH 162.215.213.154:3306` — o WordPress mudou de
 * servidor e `WP_DB_HOST` ficou com o endereço velho. Não é firewall, é rota
 * inexistente. (Efeito colateral que ninguém tinha notado: TUDO que usa
 * `WpDbService` está quebrado em silêncio — carrinhos abandonados, importação
 * de fotos, realinhamento.)
 *
 * A REST, por outro lado, responde: o site está no ar atrás da Cloudflare e
 * `WC_URL`/`WC_CONSUMER_KEY`/`WC_CONSUMER_SECRET` estão configurados. Mais
 * lenta que SQL, e não depende de descobrir servidor nenhum.
 *
 * ── O QUE ELE CONSERTA ──
 *
 * Dos 22.321 pedidos `source='site'`, só 2.238 têm CPF na nossa cópia: o sync
 * antigo nunca trouxe o `_billing_cpf`. O dado sempre existiu no WooCommerce.
 *
 * Sem CPF no pedido, o ETL de clientes não tem o que propagar — e sem CPF no
 * cadastro não há `personKey`, sem `personKey` a mesma pessoa vira cinco
 * linhas na busca do PDV. A corrente inteira começa aqui.
 *
 * ── DECISÕES ──
 *
 * · RODA EM SEGUNDO PLANO com estado consultável. São ~224 páginas de 100
 *   pedidos; uma requisição HTTP que espera tudo isso morre no gateway antes
 *   de terminar — e morreria DEPOIS de já ter gravado metade, sem ninguém
 *   saber quanto.
 * · RETOMÁVEL: guarda a última página concluída. Se cair na 180, recomeça da
 *   180, não da 1.
 * · SÓ PREENCHE VAZIO. Nunca sobrescreve CPF que já está lá — o do PDV foi
 *   digitado por vendedora olhando documento e vale mais que o do checkout.
 * · Cada plugin brasileiro grava o CPF num lugar: `billing.cpf` no corpo, ou
 *   `_billing_cpf`/`billing_cpf` no `meta_data`. Cobre os três.
 */
@Injectable()
export class CpfRestService {
  private readonly logger = new Logger(CpfRestService.name);

  private estado = {
    rodando: false,
    pagina: 0,
    totalPaginas: 0,
    pedidosLidos: 0,
    cpfsGravados: 0,
    semCpfNoWoo: 0,
    erros: 0,
    ultimoErro: null as string | null,
    iniciadoEm: null as string | null,
    terminadoEm: null as string | null,
    cancelar: false,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly wc: WooCommerceService,
  ) {}

  status() {
    return { ...this.estado };
  }

  cancelar() {
    this.estado.cancelar = true;
    return { ok: true, rodando: this.estado.rodando };
  }

  /** `de` permite retomar: `?de=180` recomeça na página 180. */
  iniciar(de = 1) {
    if (this.estado.rodando) return { iniciado: false, motivo: 'já está rodando', estado: this.status() };
    this.estado = {
      ...this.estado,
      rodando: true,
      pagina: de - 1,
      cpfsGravados: 0,
      pedidosLidos: 0,
      semCpfNoWoo: 0,
      erros: 0,
      ultimoErro: null,
      iniciadoEm: new Date().toISOString(),
      terminadoEm: null,
      cancelar: false,
    };
    void this.rodar(de);
    return { iniciado: true, estado: this.status() };
  }

  /** Extrai o CPF de onde quer que o plugin tenha posto. */
  private cpfDoPedido(o: any): string {
    const meta: any[] = Array.isArray(o?.meta_data) ? o.meta_data : [];
    const bruto =
      o?.billing?.cpf ||
      meta.find((m) => m?.key === '_billing_cpf')?.value ||
      meta.find((m) => m?.key === 'billing_cpf')?.value ||
      '';
    const so = String(bruto || '').replace(/\D/g, '');
    return so.length === 11 ? so : '';
  }

  private async rodar(de: number) {
    try {
      let pagina = de;
      for (;;) {
        if (this.estado.cancelar) {
          this.logger.warn('[cpf-rest] cancelado a pedido');
          break;
        }
        const r = await this.wc.listOrders({ page: pagina, perPage: 100, status: 'any' });
        this.estado.totalPaginas = r.totalPages || this.estado.totalPaginas;
        const pedidos = r.data || [];
        if (!pedidos.length) break;

        for (const o of pedidos) {
          this.estado.pedidosLidos++;
          const cpf = this.cpfDoPedido(o);
          if (!cpf) { this.estado.semCpfNoWoo++; continue; }
          const wcId = Number(o?.id);
          if (!Number.isFinite(wcId)) continue;
          try {
            /**
             * `customer_cpf: null` no WHERE é de propósito: o `updateMany` só
             * toca em quem está vazio, então rodar de novo não desfaz nada e
             * não custa escrita.
             */
            const upd = await (this.prisma as any).order.updateMany({
              where: { wcOrderId: wcId, OR: [{ customerCpf: null }, { customerCpf: '' }] },
              data: { customerCpf: cpf },
            });
            this.estado.cpfsGravados += upd.count;
          } catch (e: any) {
            this.estado.erros++;
            this.estado.ultimoErro = e?.message ?? String(e);
          }
        }

        this.estado.pagina = pagina;
        if (pagina % 10 === 0) {
          this.logger.log(
            `[cpf-rest] página ${pagina}/${this.estado.totalPaginas} · ${this.estado.cpfsGravados} CPFs gravados`,
          );
        }
        if (this.estado.totalPaginas && pagina >= this.estado.totalPaginas) break;
        pagina++;
      }
      this.logger.log(
        `[cpf-rest] FIM — ${this.estado.pedidosLidos} pedidos lidos, ${this.estado.cpfsGravados} CPFs gravados`,
      );
    } catch (e: any) {
      this.estado.erros++;
      this.estado.ultimoErro = e?.message ?? String(e);
      this.logger.error(`[cpf-rest] parou na página ${this.estado.pagina}: ${this.estado.ultimoErro}`);
    } finally {
      this.estado.rodando = false;
      this.estado.terminadoEm = new Date().toISOString();
    }
  }

  /**
   * SEGUNDO PASSO — leva o CPF do PEDIDO pro CADASTRO, casando por e-mail.
   *
   * Separado do sync de propósito: são coisas que falham por motivos
   * diferentes (rede x dado), e juntar faria uma esconder a outra.
   *
   * Descarta e-mail que aparece com CPFs DIFERENTES: é família ou conta
   * compartilhada, e trocar CPF mistura o histórico de duas pessoas — só
   * aparece quando dá problema no crediário. Faltar é melhor que trocar.
   */
  async propagarParaClientes(aplicar = false) {
    const pedidos: Array<{ customerEmail: string | null; customerCpf: string | null }> = await (
      this.prisma as any
    ).order.findMany({
      where: { source: { in: ['site', 'ecommerce'] }, NOT: [{ customerCpf: null }, { customerCpf: '' }] },
      select: { customerEmail: true, customerCpf: true },
    });

    const porEmail = new Map<string, Set<string>>();
    for (const p of pedidos) {
      const e = String(p.customerEmail || '').trim().toLowerCase();
      const c = String(p.customerCpf || '').replace(/\D/g, '');
      if (!e || c.length !== 11) continue;
      if (!porEmail.has(e)) porEmail.set(e, new Set());
      porEmail.get(e)!.add(c);
    }

    const alvos: Array<{ id: string; email: string | null }> = await (this.prisma as any).customer.findMany({
      where: { OR: [{ cpf: null }, { cpf: '' }], NOT: [{ email: null }] },
      select: { id: true, email: true },
    });

    let casaram = 0, ambiguos = 0, semCorrespondencia = 0, aplicados = 0;
    for (const cli of alvos) {
      const e = String(cli.email || '').trim().toLowerCase();
      const achados = porEmail.get(e);
      if (!achados?.size) { semCorrespondencia++; continue; }
      if (achados.size > 1) { ambiguos++; continue; }
      casaram++;
      if (!aplicar) continue;
      const cpf = [...achados][0];
      try {
        await (this.prisma as any).customer.update({
          where: { id: cli.id },
          // `personKey` junto: é ele que faz o CRM enxergar a pessoa atrás dos
          // cadastros. CPF sem personKey resolveria metade do problema.
          data: { cpf, personKey: `cpf:${cpf}` },
        });
        aplicados++;
      } catch (e2: any) {
        this.logger.warn(`[cpf-rest] ${cli.id} não gravou: ${e2?.message}`);
      }
    }
    return {
      emailsComCpf: porEmail.size,
      cadastrosSemCpf: alvos.length,
      casaram,
      ambiguos,
      semCorrespondencia,
      aplicados,
      seco: !aplicar,
    };
  }
}
