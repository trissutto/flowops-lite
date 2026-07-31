/**
 * BACKFILL — transferências de venda de canal (site/live) para a loja 13.
 *
 * Regra do dono (30/07/2026): toda peça que uma loja envia para atender pedido
 * de SITE ou de LIVE tem que estar registrada como transferência da loja de
 * origem para a loja-canal 13, com o acerto REDE × franquia.
 *
 * O código antigo divergia disso em dois pontos:
 *   a) LIVE acertava com a loja que fez a live (session.liveStoreCode);
 *   b) SITE usava o código fantasma 'SITE', que não existe na tabela Store.
 * Além disso, saída de loja PRÓPRIA não gerava registro nenhum (a condição
 * juntava "registrar" com "cobrar").
 *
 * ⚠️ ESTE SCRIPT MEXE EM ACERTO FINANCEIRO JÁ LANÇADO.
 * Por isso ele roda em CONFERÊNCIA por padrão: lista tudo o que mudaria e não
 * grava nada. Só grava com --aplicar, e mesmo assim:
 *   - nunca toca em obrigação com status diferente de 'pending'
 *     (acerto já pago/fechado é histórico — corrigir isso é decisão contábil,
 *     não de script);
 *   - nunca cria cobrança nova onde não havia (mudar de destino não pode
 *     inventar dívida);
 *   - grava um resumo do antes/depois pra auditoria.
 *
 * USO:
 *   npx ts-node scripts/backfill-transferencia-canal.ts            # confere
 *   npx ts-node scripts/backfill-transferencia-canal.ts --aplicar  # grava
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');
const CANAL = '13';

interface Divergencia {
  transferOrderId: string;
  tipo: string;
  refCode: string;
  origem: string;
  destinoAtual: string;
  destinoNovo: string;
  obrigacaoId?: string;
  obrigacaoStatus?: string;
  acao: string;
}

async function main() {
  console.log(
    APLICAR
      ? '⚠️  MODO APLICAR — as alterações SERÃO gravadas.\n'
      : '🔍 MODO CONFERÊNCIA — nada será gravado. Use --aplicar para gravar.\n',
  );

  const canal: any = await (prisma as any).store.findUnique({ where: { code: CANAL } });
  if (!canal) {
    console.error(`✖ Loja-canal ${CANAL} não existe na tabela Store. Abortado.`);
    process.exit(1);
  }
  console.log(`Loja-canal: ${canal.code} · ${canal.name} · tipo=${canal.tipo}\n`);

  // Transferências de venda de canal cujo destino não é a loja 13.
  const transfers: any[] = await (prisma as any).transferOrder.findMany({
    where: { tipo: { in: ['SITE', 'LIVE'] }, lojaDestinoCode: { not: CANAL } },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Transferências de canal com destino divergente: ${transfers.length}\n`);
  if (transfers.length === 0) {
    console.log('Nada a corrigir.');
    return;
  }

  const divergencias: Divergencia[] = [];
  const porDestinoAntigo = new Map<string, number>();

  for (const t of transfers) {
    porDestinoAntigo.set(t.lojaDestinoCode, (porDestinoAntigo.get(t.lojaDestinoCode) ?? 0) + 1);

    const obrigacao: any = await (prisma as any).interStoreObligation
      .findFirst({ where: { transferOrderId: t.id } })
      .catch(() => null);

    // Obrigação já liquidada é histórico contábil — não se reescreve por script.
    const travada = obrigacao && obrigacao.status !== 'pending';

    divergencias.push({
      transferOrderId: t.id,
      tipo: t.tipo,
      refCode: t.refCode,
      origem: `${t.lojaOrigemCode} ${t.lojaOrigemName}`,
      destinoAtual: `${t.lojaDestinoCode} ${t.lojaDestinoName}`,
      destinoNovo: `${canal.code} ${canal.name}`,
      obrigacaoId: obrigacao?.id,
      obrigacaoStatus: obrigacao?.status,
      acao: travada
        ? 'PULAR — obrigação já liquidada (decisão contábil, não de script)'
        : obrigacao
          ? 'corrigir transferência + obrigação (ambas pendentes)'
          : 'corrigir só a transferência (sem obrigação vinculada)',
    });
  }

  console.log('── Destinos antigos encontrados ──');
  for (const [code, qtd] of porDestinoAntigo) console.log(`  ${code}: ${qtd} transferência(s)`);

  const travadas = divergencias.filter((d) => d.acao.startsWith('PULAR'));
  const corrigiveis = divergencias.filter((d) => !d.acao.startsWith('PULAR'));

  console.log(`\n── Resumo ──`);
  console.log(`  corrigíveis: ${corrigiveis.length}`);
  console.log(`  puladas (acerto já liquidado): ${travadas.length}`);

  console.log(`\n── Primeiras 20 corrigíveis ──`);
  for (const d of corrigiveis.slice(0, 20)) {
    console.log(
      `  [${d.tipo}] ${d.refCode} · ${d.origem} → ${d.destinoAtual} ⇒ ${d.destinoNovo}` +
        (d.obrigacaoStatus ? ` · obrigação=${d.obrigacaoStatus}` : ' · sem obrigação'),
    );
  }

  if (travadas.length > 0) {
    console.log(`\n⚠️  ${travadas.length} transferência(s) com acerto já liquidado NÃO serão tocadas.`);
    console.log('   Revise com a contabilidade se o destino delas também precisa mudar.');
  }

  if (!APLICAR) {
    console.log('\n🔍 Conferência concluída. Nada foi gravado.');
    console.log('   Revise a lista acima e rode com --aplicar quando estiver de acordo.');
    return;
  }

  console.log('\n⚠️  Aplicando...');
  let ok = 0;
  for (const d of corrigiveis) {
    await (prisma as any).$transaction(async (tx: any) => {
      await tx.transferOrder.update({
        where: { id: d.transferOrderId },
        data: { lojaDestinoCode: canal.code, lojaDestinoName: canal.name },
      });
      if (d.obrigacaoId) {
        // Só o destino muda. Valor, divisor e mês de referência ficam como
        // estavam — a correção é de PARA QUEM, não de QUANTO.
        await tx.interStoreObligation.update({
          where: { id: d.obrigacaoId },
          data: {
            toStoreCode: canal.code,
            toStoreName: canal.name,
            toStoreTipo: canal.tipo === 'FILIAL' ? 'FILIAL' : 'REDE',
          },
        });
      }
    });
    ok++;
    if (ok % 50 === 0) console.log(`  ${ok}/${corrigiveis.length}...`);
  }

  console.log(`\n✔ ${ok} transferência(s) corrigida(s). ${travadas.length} pulada(s).`);
}

main()
  .catch((e) => {
    console.error('✖ Falhou:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
