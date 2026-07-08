import { BadRequestException, Body, Controller, ForbiddenException, Post, Query, Req } from '@nestjs/common';
import { LivePdvService } from './live-pdv.service';

/**
 * Controller PÚBLICO (SEM JwtAuthGuard) — cadastro da cliente na Live.
 *
 * Fluxo: na live a cliente escreve "CARRINHO" → o ManyChat manda o link
 *   https://<front>/cadastro-live?ig=@fulana&nome=Fulana&t=<token>
 * A página pública posta aqui. Reaproveita quickCustomer (dedup por telefone/@,
 * grava em Customer com originSource='live').
 *
 * Como é público, tem 2 defesas contra abuso:
 *   1. TOKEN opcional (env CADASTRO_LIVE_TOKEN): se setado, exige `t` batendo.
 *      Sem a env, fica aberto (funciona out-of-the-box; recomendado setar em prod).
 *   2. Rate-limit em memória por IP (janela deslizante).
 */

const RL_WINDOW_MS = 60_000; // 1 min
const RL_MAX = 5;            // máx cadastros por IP por janela
const rlHits = new Map<string, number[]>();

@Controller('public/cadastro-live')
export class LivePublicController {
  constructor(private readonly svc: LivePdvService) {}

  @Post()
  async cadastro(
    @Req() req: any,
    @Body() body: { name?: string; phone?: string; instagram?: string; token?: string; sid?: string },
  ) {
    // 1. Token (se configurado no ambiente)
    const expected = (process.env.CADASTRO_LIVE_TOKEN || '').trim();
    if (expected && String(body?.token || '').trim() !== expected) {
      throw new ForbiddenException('Link inválido ou expirado');
    }

    // 2. Rate-limit por IP
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      throw new BadRequestException('Muitas tentativas. Aguarde um instante e tente de novo.');
    }

    // 3. Validação básica
    const name = String(body?.name || '').trim();
    const phoneDigits = String(body?.phone || '').replace(/\D/g, '');
    if (name.length < 2) throw new BadRequestException('Informe seu nome.');
    if (!isValidBrCell(phoneDigits)) {
      throw new BadRequestException('Celular inválido. Use DDD + número (ex.: 11 91234-5678).');
    }

    const result = await this.svc.quickCustomer({
      name,
      phone: phoneDigits,
      instagram: body?.instagram || undefined,
      markLiveRegistration: true, // veio do link da live → entra na fila "Cadastradas na live"
      // &sid= do ManyChat (User ID do assinante) — base do DM automático (Fase 2)
      manychatSubscriberId: body?.sid || undefined,
    });

    // Devolve só o necessário pra tela de sucesso (sem vazar PII/id interno).
    return { ok: true, name: result.name, instagram: result.instagram };
  }
}

/**
 * Webhook PÚBLICO do ManyChat (External Request) — vínculo @→subscriber_id.
 *
 * Uso no ManyChat: automação (disparo por etiqueta `vincular_flow` ou no fluxo
 * CARRINHO) com ação "Solicitação Externa": POST em
 *   .../api/public/manychat-link?t=<MANYCHAT_HOOK_TOKEN>
 * com corpo "Full Contact Data" (o JSON completo do contato que o ManyChat
 * monta sozinho — traz id, ig_username, name, phone). Também aceita o formato
 * enxuto { token, sid, ig, name, phone } pra chamadas manuais/testes.
 * Aplicar a etiqueta em massa nos contatos = backfill de todos os vínculos.
 *
 * Defesas: token via env MANYCHAT_HOOK_TOKEN (cai pro CADASTRO_LIVE_TOKEN se
 * não setada) + rate-limit LARGO por IP (o backfill em massa é rajada legítima
 * vinda dos servidores do ManyChat).
 */
const HOOK_RL_WINDOW_MS = 60_000;
const HOOK_RL_MAX = 2_000; // rajada do backfill em massa é esperada
const hookHits = new Map<string, number[]>();

@Controller('public/manychat-link')
export class ManychatHookController {
  constructor(private readonly svc: LivePdvService) {}

  @Post()
  async link(
    @Req() req: any,
    @Query('t') t: string | undefined,
    @Body() body: any,
  ) {
    const expected = (
      process.env.MANYCHAT_HOOK_TOKEN || process.env.CADASTRO_LIVE_TOKEN || ''
    ).trim();
    const got = String(t || body?.token || '').trim();
    if (expected && got !== expected) {
      throw new ForbiddenException('Token inválido');
    }
    const ip = clientIp(req);
    const now = Date.now();
    const arr = (hookHits.get(ip) || []).filter((ts) => now - ts < HOOK_RL_WINDOW_MS);
    arr.push(now);
    hookHits.set(ip, arr);
    if (arr.length > HOOK_RL_MAX) {
      throw new BadRequestException('Rate limit');
    }
    // Full Contact Data (id/ig_username) ou formato enxuto (sid/ig)
    return this.svc.upsertManychatLink({
      sid: body?.sid || body?.id,
      ig: body?.ig || body?.ig_username,
      name: body?.name,
      phone: body?.phone || body?.whatsapp_phone,
    });
  }
}

/** Celular BR: 10 dígitos (fixo antigo) ou 11 (com 9). Aceita DDD 11–99. */
function isValidBrCell(digits: string): boolean {
  if (digits.length !== 10 && digits.length !== 11) return false;
  const ddd = parseInt(digits.slice(0, 2), 10);
  if (isNaN(ddd) || ddd < 11 || ddd > 99) return false;
  // 11 dígitos → celular deve começar com 9 após o DDD
  if (digits.length === 11 && digits[2] !== '9') return false;
  return true;
}

function clientIp(req: any): string {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req?.ip || req?.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  arr.push(now);
  rlHits.set(ip, arr);
  // Limpeza defensiva pra não crescer indefinidamente
  if (rlHits.size > 5000) {
    for (const [k, v] of rlHits) {
      if (!v.some((t) => now - t < RL_WINDOW_MS)) rlHits.delete(k);
    }
  }
  return arr.length > RL_MAX;
}
