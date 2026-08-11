import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WpDbService } from '../wp-db/wp-db.service';

/**
 * O CPF DAS 14 MIL CLIENTES DO SITE ANTIGO.
 *
 * ── O PROBLEMA (medido em 10/08/2026) ──
 *
 * A base do CRM tem 23.453 cadastros e **74% deles não têm CPF** — e CPF é a
 * identidade da casa ("CPF é a PESSOA"). Sem ele não há `personKey`, sem
 * `personKey` não há como saber que dois cadastros são a mesma pessoa, e o CRM
 * mostra três desconhecidas onde existe uma cliente. Hoje há 421 telefones
 * repetidos em 865 cadastros exatamente por isso.
 *
 * O maior bloco é a importação do WooCommerce: 14.547 cadastros `origin_source
 * = 'woo'` sem CPF. Cruzando com o que já existe no Postgres dá pra preencher
 * só 501 (3,4%) — os outros ~14 mil estão no banco do WordPress e em nenhum
 * outro lugar.
 *
 * ── POR QUE ISTO VIVE NO BACKEND, E NÃO NUM SCRIPT ──
 *
 * O MySQL do WordPress fica atrás do firewall por IP da KingHost: só o Railway
 * passa. Rodar da máquina de quem desenvolve dá `ETIMEDOUT` — testado.
 *
 * ── AS DUAS ARMADILHAS DO SCHEMA ──
 *
 * 1. CADA PLUGIN BRASILEIRO GRAVA O CPF COM UM NOME. O próprio
 *    `catalog.service.ts` escreve em `_billing_cpf` E `billing_cpf` de
 *    propósito. Aqui a leitura cobre os dois, nos dois lugares onde o dado
 *    pode estar: na CONTA (`wp_usermeta`) e no PEDIDO (`wp_postmeta`).
 *
 * 2. HPOS. O WooCommerce novo move pedido de `wp_postmeta` pra `wp_wc_orders`.
 *    O diagnóstico detecta qual está em uso em vez de supor — supor aqui
 *    devolveria "nenhum CPF encontrado" num banco cheio deles.
 *
 * ── O QUE NUNCA FAZ ──
 *
 * Não sobrescreve CPF existente, e não preenche quando o mesmo e-mail aparece
 * com CPFs DIFERENTES no WooCommerce (e-mail de família, conta compartilhada).
 * Nesses casos errar é pior que faltar: CPF trocado mistura o histórico de
 * duas pessoas, e ninguém descobre até dar problema no crediário.
 */
@Injectable()
export class CpfWooService {
  private readonly logger = new Logger(CpfWooService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wp: WpDbService,
  ) {}

  /** O que existe do outro lado — antes de tentar qualquer cruzamento. */
  async diagnostico() {
    const tabelas = await this.wp
      .query<any>(`SHOW TABLES LIKE '%wc_order%'`)
      .catch(() => []);
    const temHpos = (tabelas as any[]).some((t) =>
      Object.values(t).some((v) => String(v) === 'wp_wc_orders'),
    );

    const chaves = await this.wp
      .query<any>(
        `SELECT meta_key, COUNT(*) AS n
           FROM wp_postmeta
          WHERE meta_key IN ('_billing_cpf','billing_cpf','_billing_email')
          GROUP BY meta_key`,
      )
      .catch((e) => [{ erro: e?.message }]);

    const chavesConta = await this.wp
      .query<any>(
        `SELECT meta_key, COUNT(*) AS n
           FROM wp_usermeta
          WHERE meta_key IN ('_billing_cpf','billing_cpf')
          GROUP BY meta_key`,
      )
      .catch((e) => [{ erro: e?.message }]);

    return { temHpos, noPedido: chaves, naConta: chavesConta };
  }

  /**
   * E-mail → CPF, juntando CONTA e PEDIDO.
   *
   * O `Map` guarda um `Set` de CPFs por e-mail justamente pra flagrar
   * divergência: dois CPFs no mesmo e-mail viram descarte, não escolha.
   */
  private async mapaDoWoo(): Promise<Map<string, Set<string>>> {
    const mapa = new Map<string, Set<string>>();
    const guardar = (email: unknown, cpf: unknown) => {
      const e = String(email || '').trim().toLowerCase();
      const c = String(cpf || '').replace(/\D/g, '');
      if (!e || !e.includes('@') || c.length !== 11) return;
      if (!mapa.has(e)) mapa.set(e, new Set());
      mapa.get(e)!.add(c);
    };

    const daConta = await this.wp
      .query<any>(
        `SELECT u.user_email AS email, um.meta_value AS cpf
           FROM wp_users u
           JOIN wp_usermeta um ON um.user_id = u.ID
          WHERE um.meta_key IN ('billing_cpf','_billing_cpf')
            AND um.meta_value <> ''`,
      )
      .catch((e) => {
        this.logger.warn(`[cpf-woo] conta indisponível: ${e?.message}`);
        return [];
      });
    (daConta as any[]).forEach((r) => guardar(r.email, r.cpf));

    const doPedido = await this.wp
      .query<any>(
        `SELECT em.meta_value AS email, cp.meta_value AS cpf
           FROM wp_postmeta cp
           JOIN wp_postmeta em
             ON em.post_id = cp.post_id AND em.meta_key = '_billing_email'
          WHERE cp.meta_key IN ('_billing_cpf','billing_cpf')
            AND cp.meta_value <> ''`,
      )
      .catch((e) => {
        this.logger.warn(`[cpf-woo] pedido indisponível: ${e?.message}`);
        return [];
      });
    (doPedido as any[]).forEach((r) => guardar(r.email, r.cpf));

    return mapa;
  }

  /**
   * `aplicar = false` só conta. É o padrão de propósito: são 14 mil cadastros
   * e não existe desfazer barato.
   */
  async backfill(aplicar = false) {
    const mapa = await this.mapaDoWoo();

    const alvos: Array<{ id: string; email: string | null }> = await (
      this.prisma as any
    ).customer.findMany({
      where: { originSource: 'woo', OR: [{ cpf: null }, { cpf: '' }] },
      select: { id: true, email: true },
    });

    let casaram = 0;
    let ambiguos = 0;
    let semEmail = 0;
    let semCorrespondencia = 0;
    const paraGravar: Array<{ id: string; cpf: string }> = [];

    for (const cli of alvos) {
      const email = String(cli.email || '').trim().toLowerCase();
      if (!email) { semEmail++; continue; }
      const achados = mapa.get(email);
      if (!achados || achados.size === 0) { semCorrespondencia++; continue; }
      if (achados.size > 1) { ambiguos++; continue; }
      casaram++;
      paraGravar.push({ id: cli.id, cpf: [...achados][0] });
    }

    const resumo = {
      emailsComCpfNoWoo: mapa.size,
      cadastrosWooSemCpf: alvos.length,
      casaram,
      ambiguos,
      semEmail,
      semCorrespondencia,
      aplicado: 0,
    };

    if (!aplicar) return { ...resumo, seco: true };

    for (const p of paraGravar) {
      try {
        await (this.prisma as any).customer.update({
          where: { id: p.id },
          // `personKey` junto: é ele que permite ao CRM enxergar que dois
          // cadastros são a mesma pessoa. CPF sem personKey resolve metade.
          data: { cpf: p.cpf, personKey: `cpf:${p.cpf}` },
        });
        resumo.aplicado++;
      } catch (e: any) {
        this.logger.warn(`[cpf-woo] ${p.id} não gravou: ${e?.message}`);
      }
    }
    this.logger.log(`[cpf-woo] ${resumo.aplicado} cadastro(s) ganharam CPF`);
    return resumo;
  }
}
