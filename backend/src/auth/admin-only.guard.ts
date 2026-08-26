import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * AdminOnly — decorator + guard pra restringir endpoints só pra role=admin
 * (e operator quando aplicável). Substitui o padrão repetido de:
 *
 *   if (req.user.role !== 'admin') throw new ForbiddenException('Apenas admin');
 *
 * Uso:
 *   @UseGuards(JwtAuthGuard, AdminOnlyGuard)
 *   @AdminOnly()
 *   export class FinanceiroController { ... }
 *
 * Ou no método:
 *   @AdminOnly()
 *   @Get('admin-thing')
 *   admin() { ... }
 *
 * Por padrão aceita 'admin' e 'operator' (matriz). Pra exigir só 'admin':
 *   @AdminOnly({ strict: true })
 */

export const ADMIN_ONLY_KEY = 'adminOnly';
export const ADMIN_ONLY_STRICT_KEY = 'adminOnlyStrict';
export const PERMITE_LOJA_KEY = 'permiteLoja';

export const AdminOnly = (opts: { strict?: boolean } = {}) =>
  SetMetadata(ADMIN_ONLY_KEY, { strict: !!opts.strict });

/**
 * ESCAPE HATCH POR LOJA — abre um endpoint `@AdminOnly()` pra usuário de LOJA
 * cujo `storeCode` esteja na env informada (lista separada por vírgula).
 *
 * Nasceu em 26/08/2026 pra soltar a fila de carrinho abandonado pra Santos
 * (`CARRINHO_LOJAS=02`) como piloto. A régua é env e não código porque a ideia
 * é abrir loja a loja conforme o atendimento se prova — trocar a env não pede
 * deploy, e esvaziar a env volta tudo a ser só da matriz.
 *
 * NÃO afeta endpoint nenhum sem o decorator: sem `@PermiteLoja` o guard segue
 * exatamente como antes.
 *
 *   @PermiteLoja('CARRINHO_LOJAS')
 *   @Controller('abandoned-carts')
 */
export const PermiteLoja = (envVar: string) => SetMetadata(PERMITE_LOJA_KEY, envVar);

@Injectable()
export class AdminOnlyGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Procura o metadata no método primeiro, depois na classe
    const meta =
      this.reflector.get<{ strict?: boolean } | undefined>(
        ADMIN_ONLY_KEY,
        context.getHandler(),
      ) ??
      this.reflector.get<{ strict?: boolean } | undefined>(
        ADMIN_ONLY_KEY,
        context.getClass(),
      );

    // Sem metadata = endpoint público pra qualquer role autenticado
    if (!meta) return true;

    const req = context.switchToHttp().getRequest();
    const role = req?.user?.role;

    if (!role) {
      throw new ForbiddenException('Não autenticado');
    }

    if (meta.strict) {
      // strict = só admin (sem operator)
      if (role !== 'admin') {
        throw new ForbiddenException('Apenas admin (matriz com senha master)');
      }
    } else {
      // padrão: matriz (admin + operator)
      if (role !== 'admin' && role !== 'operator') {
        // ESCAPE HATCH POR LOJA — ver `PermiteLoja`. Só entra aqui quem já ia
        // levar 403: loja fora da lista continua barrada exatamente como antes.
        if (this.lojaLiberada(context, req)) return true;
        throw new ForbiddenException(
          'Apenas matriz — esta operação não está disponível pra loja',
        );
      }
    }

    return true;
  }

  /** `@PermiteLoja('ENV')` + `storeCode` do JWT dentro da lista da env. */
  private lojaLiberada(context: ExecutionContext, req: any): boolean {
    const envVar =
      this.reflector.get<string | undefined>(PERMITE_LOJA_KEY, context.getHandler()) ??
      this.reflector.get<string | undefined>(PERMITE_LOJA_KEY, context.getClass());
    if (!envVar) return false;

    const permitidas = String(process.env[envVar] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!permitidas.length) return false;

    // `storeCode` é o código da loja no JWT ('02' = Santos). Comparo como texto
    // e sem zero à esquerda também, porque o código vive como '02' no cadastro
    // e alguém escrevendo `CARRINHO_LOJAS=2` na env não deve virar bug mudo.
    const code = String(req?.user?.storeCode ?? '').trim();
    if (!code) return false;
    const semZero = code.replace(/^0+/, '');
    return permitidas.some((p) => p === code || p.replace(/^0+/, '') === semZero);
  }
}
