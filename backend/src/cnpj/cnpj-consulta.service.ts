import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
  CadastroCnpj,
  ConsultaCnpj,
  cnpjValido,
  lerBrasilApi,
  lerCnpjWs,
  lerCnpja,
} from '../common/cnpj-cadastro';

/**
 * CONSULTA PÚBLICA DO CNPJ (16/11/2026) — razão social, endereço e situação
 * cadastral de uma empresa, pra nota sair com o destinatário completo.
 *
 * O motivo está em `common/cnpj-cadastro.ts`: desde 16/11/2026 a SEFAZ confere
 * o CNPJ do destinatário na base da Receita pela chave UF + CNPJ, e cupom sem
 * o endereço do destinatário (sem UF) volta com a rejeição 181.
 *
 * TRÊS fontes públicas e gratuitas, na ordem — a primeira que responder com o
 * cadastro ganha. Nenhuma pede chave; as três têm limite baixo por minuto, o
 * que sobra pra uma rede que tira meia dúzia de notas pra CNPJ por dia.
 *
 * - `inexistente` só sai quando alguma fonte RESPONDEU que não tem o CNPJ e
 *   nenhuma o achou. É um aviso pra quem está na tela ("confira o número"),
 *   NUNCA uma trava: as bases públicas são cópias e empresa aberta ontem pode
 *   não estar nelas ainda. Quem decide é a SEFAZ.
 * - `indisponivel` = ninguém respondeu. A nota segue como seguia.
 *
 * Só o número do CNPJ sai do sistema — é o cartão CNPJ, dado público.
 * Kill-switch: `CNPJ_CONSULTA=0`.
 */

interface Fonte {
  nome: string;
  url: (cnpj: string) => string;
  ler: (json: any) => CadastroCnpj | null;
}

const FONTES: Fonte[] = [
  { nome: 'brasilapi', url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`, ler: lerBrasilApi },
  { nome: 'cnpjws', url: (c) => `https://publica.cnpj.ws/cnpj/${c}`, ler: lerCnpjWs },
  { nome: 'cnpja', url: (c) => `https://open.cnpja.com/office/${c}`, ler: lerCnpja },
];

/** Teto de cada chamada. A nota do balcão não pode ficar pendurada num site de terceiro. */
const TIMEOUT_POR_FONTE_MS = 4000;
const CACHE_ACHOU_MS = 12 * 60 * 60 * 1000;
const CACHE_NAO_ACHOU_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

@Injectable()
export class CnpjConsultaService {
  private readonly logger = new Logger(CnpjConsultaService.name);
  private readonly cache = new Map<string, { ate: number; r: ConsultaCnpj }>();

  private desligada(): boolean {
    return String(process.env.CNPJ_CONSULTA ?? '1').trim() === '0';
  }

  /**
   * @param prazoMs teto TOTAL da consulta (todas as fontes somadas). A emissão
   *   da nota passa um prazo curto; a tela pode esperar as três.
   */
  async consultar(cnpjCru: unknown, opts: { prazoMs?: number } = {}): Promise<ConsultaCnpj> {
    const cnpj = String(cnpjCru ?? '').replace(/\D/g, '');
    if (!cnpjValido(cnpj)) return { status: 'invalido' };
    if (this.desligada()) return { status: 'indisponivel', erro: 'consulta de CNPJ desligada (CNPJ_CONSULTA=0)' };

    const agora = Date.now();
    const guardado = this.cache.get(cnpj);
    if (guardado && guardado.ate > agora) return guardado.r;

    const limite = agora + Math.max(1000, opts.prazoMs ?? FONTES.length * TIMEOUT_POR_FONTE_MS);
    let naoAcharam = 0;
    const erros: string[] = [];
    for (const fonte of FONTES) {
      const resta = limite - Date.now();
      if (resta < 500) {
        erros.push(`${fonte.nome}: sem tempo`);
        continue;
      }
      try {
        const resp = await axios.get(fonte.url(cnpj), {
          timeout: Math.min(TIMEOUT_POR_FONTE_MS, resta),
          validateStatus: () => true,
          headers: { Accept: 'application/json', 'User-Agent': 'FlowOps-Lurds/1.0 (consulta de CNPJ para nota fiscal)' },
        });
        if (resp.status === 200) {
          const cadastro = fonte.ler(resp.data);
          // A fonte tem que devolver O CNPJ perguntado — resposta de outro
          // estabelecimento colocaria o endereço errado numa nota fiscal.
          if (cadastro && cadastro.cnpj === cnpj) {
            return this.guardar(cnpj, { status: 'encontrado', cadastro }, CACHE_ACHOU_MS);
          }
          erros.push(`${fonte.nome}: resposta sem cadastro`);
        } else if (resp.status === 404) {
          naoAcharam++;
        } else {
          erros.push(`${fonte.nome}: HTTP ${resp.status}`);
        }
      } catch (e: any) {
        erros.push(`${fonte.nome}: ${e?.code || e?.message || e}`);
      }
    }

    if (naoAcharam > 0) {
      this.logger.warn(`[cnpj] ${cnpj}: ${naoAcharam} fonte(s) responderam que não existe${erros.length ? ` · ${erros.join(' · ')}` : ''}`);
      return this.guardar(cnpj, { status: 'inexistente' }, CACHE_NAO_ACHOU_MS);
    }
    // Ninguém respondeu: NÃO guarda — a próxima tentativa pergunta de novo.
    this.logger.warn(`[cnpj] ${cnpj}: nenhuma fonte respondeu · ${erros.join(' · ')}`);
    return { status: 'indisponivel', erro: erros.join(' · ') || 'sem resposta' };
  }

  private guardar(cnpj: string, r: ConsultaCnpj, ttlMs: number): ConsultaCnpj {
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(cnpj, { ate: Date.now() + ttlMs, r });
    return r;
  }
}
