import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * A SESSÃO DO WHATSAPP SAI DO DISCO E VAI PRO POSTGRES.
 *
 * ── POR QUE ──
 *
 * O `useMultiFileAuthState` do Baileys guarda a sessão em ARQUIVOS, e por isso
 * o serviço precisa de um **volume** montado em `/data`. No Railway, volume é
 * de instância única — e essa única decisão custa três coisas de uma vez:
 *
 *  1. **Todo deploy derruba requisição.** Sem poder rodar duas instâncias ao
 *     mesmo tempo, o Railway precisa DESLIGAR a antiga pra liberar o volume
 *     antes de a nova montar. Não existe deploy rolling; existe uma janela sem
 *     ninguém atendendo. Medido em 22/08/2026: **16 deploys no dia, ~58
 *     requisições mortas em cada um, 922 erros 5xx em 6 horas** — e nenhum
 *     deles era bug de código, era o próprio ato de publicar.
 *  2. **Não dá pra escalar horizontal.** Uma réplica é o teto, então não há
 *     redundância: quando ela para, para tudo — PDV, separação, site.
 *  3. **A sessão vive num lugar que ninguém faz backup.** O Postgres tem PITR;
 *     o volume não.
 *
 * Guardando a sessão no Postgres, o volume deixa de ser necessário e as três
 * consequências caem juntas.
 *
 * ── COMPATIBILIDADE ──
 *
 * Implementa a mesma interface que o Baileys espera (`{ creds, keys }` +
 * `saveCreds`), então o `makeWASocket` não percebe diferença. As chaves do
 * Signal são Buffers; o `BufferJSON` do próprio Baileys faz a ida e volta
 * pra JSON sem perder byte.
 *
 * ⚠️ `app-state-sync-key` precisa ser reidratado com
 * `proto.Message.AppStateSyncKeyData.fromObject` na leitura — sem isso o
 * Baileys aceita o objeto cru e falha depois, na sincronização, longe daqui.
 *
 * ── MIGRAÇÃO SEM PERDER A SESSÃO ──
 *
 * Se o Postgres ainda não tem a sessão MAS o volume tem, importa do disco na
 * primeira subida e segue pelo banco. É o que evita ter de reescanear o QR:
 * sessão do WhatsApp não se recupera, se refaz — e refazer significa alguém
 * com o celular na mão, no meio do expediente.
 */

/** Nome lógico da sessão — o mesmo processo carrega duas (site e cobrança). */
export type SessaoWa = 'principal' | 'cobranca';

/** Chave usada pra guardar as credenciais (o resto são chaves do Signal). */
const CHAVE_CREDS = 'creds';

/**
 * Os tipos de chave do Signal que o Baileys guarda. Precisamos da lista porque
 * o nome do ARQUIVO não é reversível sozinho (ver `chaveDoArquivo`).
 *
 * Ordem importa: os mais longos primeiro, senão `sender-key` casaria antes de
 * `sender-key-memory` e o resto do nome iria pro id errado.
 */
const TIPOS_DE_CHAVE = [
  'app-state-sync-version',
  'app-state-sync-key',
  'sender-key-memory',
  'sender-key',
  'pre-key',
  'session',
] as const;

/**
 * Nome de arquivo do Baileys → chave interna.
 *
 * ⚠️ NÃO É UM `replace` SIMPLES. O Baileys escreve o arquivo com
 * `fixFileName(chave)`, que troca `/` por `__` e `:` por `-`. Desfazer isso
 * com dois `replace` no nome inteiro **corrompe o tipo**: `pre-key-123` viraria
 * `pre:key:123`, e a chave nunca mais seria encontrada — a sessão migraria
 * "com sucesso" e o WhatsApp cairia depois, sem explicação.
 *
 * O jeito certo é reconhecer o TIPO pelo prefixo (que nunca tem `/` nem `:`) e
 * desfazer a troca só no ID, que é onde ela realmente aconteceu.
 */
export function chaveDoArquivo(arquivo: string): string | null {
  const base = arquivo.replace(/\.json$/, '');
  for (const tipo of TIPOS_DE_CHAVE) {
    if (base === tipo || base.startsWith(`${tipo}-`)) {
      const id = base.slice(tipo.length + 1);
      const idOriginal = id.replace(/__/g, '/').replace(/-/g, ':');
      return `${tipo}-${idOriginal}`;
    }
  }
  return null;
}

export interface EstadoAutenticacao {
  state: { creds: any; keys: any };
  saveCreds: () => Promise<void>;
}

export async function usarAuthPostgres(
  prisma: PrismaService,
  sessao: SessaoWa,
  logger: Logger,
  /** Diretório legado no volume — só pra importar uma vez, se existir. */
  dirLegado?: string,
): Promise<EstadoAutenticacao> {
  const baileys = await import('@whiskeysockets/baileys');
  const { initAuthCreds, BufferJSON, proto } = baileys as any;

  const tabela = (prisma as any).waAuth;

  /** Buffer → JSON e volta, usando o serializador do próprio Baileys. */
  const paraJson = (v: any) => JSON.parse(JSON.stringify(v, BufferJSON.replacer));
  const deJson = (v: any) => JSON.parse(JSON.stringify(v), BufferJSON.reviver);

  const ler = async (chave: string): Promise<any | null> => {
    const linha = await tabela.findUnique({ where: { sessao_chave: { sessao, chave } } });
    return linha ? deJson(linha.valor) : null;
  };

  const gravar = async (chave: string, valor: any): Promise<void> => {
    const dados = paraJson(valor);
    await tabela.upsert({
      where: { sessao_chave: { sessao, chave } },
      create: { sessao, chave, valor: dados },
      update: { valor: dados },
    });
  };

  const apagar = async (chave: string): Promise<void> => {
    await tabela.deleteMany({ where: { sessao, chave } });
  };

  // ── Migração do volume, uma vez só ──────────────────────────────────────
  let credsSalvas = await ler(CHAVE_CREDS);
  if (!credsSalvas && dirLegado) {
    credsSalvas = await importarDoDisco(dirLegado, sessao, gravar, deJson, logger);
  }

  const creds = credsSalvas ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        /**
         * O Baileys pede várias chaves de uma vez. Uma consulta só pro lote
         * inteiro — pedir uma a uma seriam dezenas de idas ao banco por
         * mensagem recebida, e isso apareceria como lentidão no envio.
         */
        get: async (tipo: string, ids: string[]) => {
          if (!ids.length) return {};
          const chaves = ids.map((id) => `${tipo}-${id}`);
          const linhas = await tabela.findMany({
            where: { sessao, chave: { in: chaves } },
            select: { chave: true, valor: true },
          });
          const porChave = new Map<string, any>(
            linhas.map((l: any) => [l.chave, l.valor]),
          );
          const saida: Record<string, any> = {};
          for (const id of ids) {
            let valor = porChave.get(`${tipo}-${id}`);
            if (valor === undefined) continue;
            valor = deJson(valor);
            // Ver o aviso do cabeçalho: sem isto a falha aparece depois, na
            // sincronização, e não parece ter relação com a sessão.
            if (tipo === 'app-state-sync-key' && valor) {
              valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            }
            saida[id] = valor;
          }
          return saida;
        },

        set: async (dados: Record<string, Record<string, any>>) => {
          const tarefas: Promise<any>[] = [];
          for (const categoria of Object.keys(dados)) {
            for (const id of Object.keys(dados[categoria] ?? {})) {
              const valor = dados[categoria][id];
              const chave = `${categoria}-${id}`;
              // Valor nulo é REMOÇÃO, não gravação de nulo — é assim que o
              // Baileys descarta pre-key já usada.
              tarefas.push(valor ? gravar(chave, valor) : apagar(chave));
            }
          }
          await Promise.all(tarefas);
        },
      },
    },
    saveCreds: async () => {
      await gravar(CHAVE_CREDS, creds);
    },
  };
}

/**
 * Traz a sessão que está no volume pro Postgres. Roda no máximo uma vez por
 * sessão: depois disto o `creds` existe no banco e este caminho não é mais
 * consultado.
 *
 * Não apaga nada do disco de propósito — se a importação sair torta, o
 * original continua lá pra tentar de novo.
 */
async function importarDoDisco(
  dir: string,
  sessao: SessaoWa,
  gravar: (chave: string, valor: any) => Promise<void>,
  deJson: (v: any) => any,
  logger: Logger,
): Promise<any | null> {
  try {
    const arqCreds = path.join(dir, 'creds.json');
    if (!fs.existsSync(arqCreds)) return null;

    const creds = deJson(JSON.parse(fs.readFileSync(arqCreds, 'utf-8')));
    await gravar(CHAVE_CREDS, creds);

    let chaves = 0;
    for (const arquivo of fs.readdirSync(dir)) {
      if (arquivo === 'creds.json' || !arquivo.endsWith('.json')) continue;
      try {
        const valor = deJson(JSON.parse(fs.readFileSync(path.join(dir, arquivo), 'utf-8')));
        const chave = chaveDoArquivo(arquivo);
        if (!chave) continue; // nome fora do padrão do Baileys — não é chave de sessão
        await gravar(chave, valor);
        chaves++;
      } catch {
        // Um arquivo corrompido não pode impedir a sessão inteira de migrar:
        // chave de Signal perdida o WhatsApp renegocia; sessão perdida, não.
      }
    }
    logger.log(
      `[wa-auth:${sessao}] sessão importada do volume pro Postgres — creds + ${chaves} chave(s). O volume não é mais necessário.`,
    );
    return creds;
  } catch (err) {
    logger.warn(`[wa-auth:${sessao}] importação do volume falhou: ${String(err)}`);
    return null;
  }
}
