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

export const AdminOnly = (opts: { strict?: boolean } = {}) =>
  SetMetadata(ADMIN_ONLY_KEY, { strict: !!opts.strict });

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
        throw new ForbiddenException(
          'Apenas matriz — esta operação não está disponível pra loja',
        );
      }
    }

    return true;
  }
}
