import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * IMPORTADOR DE CONTEÚDO (sprint 008) — WooCommerce → `site_produto`.
 * APOSENTADO no enterro do Wincred (09/2026).
 *
 * NUNCA foi um espelho permanente. Decisão do dono (30/07): o cadastro
 * comercial vive no Flow; este serviço existiu pra trazer de uma vez o que já
 * tinha sido escrito no site antigo (descrição, SEO, fotos) e manter
 * atualizado só o que o Flow ainda não tinha assumido (`origemConteudo`).
 *
 * O host do WordPress foi APAGADO (KingHost, 27/08) — não existe mais de onde
 * importar. O cron diário, o `sincronizarConteudo` e a rota
 * POST /loja-catalog/importar foram removidos: rodavam, estouravam no
 * primeiro GET e gravavam uma linha de falha no log toda madrugada.
 *
 * O que fica: o HISTÓRICO das rodadas (`site_sync_log`), que a tela de admin
 * ainda lê — é o registro de como o catálogo foi migrado.
 */
@Injectable()
export class SiteSyncService {
  constructor(private readonly prisma: PrismaService) {}

  /** Últimas rodadas — a tela de admin lê daqui. */
  historico(limite = 20) {
    return (this.prisma as any).siteSyncLog.findMany({
      orderBy: { iniciadoEm: 'desc' },
      take: Math.min(100, limite),
    });
  }
}
