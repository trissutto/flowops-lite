import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

/**
 * Guard pra rotas DO APP CLIENTE FINAL (app.lurds.com.br).
 *
 * Distingue do `JwtAuthGuard` (operador/admin) checando o claim `scope`:
 *   - scope='customer'  → este guard valida
 *   - scope='user' (ou ausente) → rejeitado aqui (e validado pelo outro guard)
 *
 * Por que separar: o JWT do operador carrega storeId/role e dá acesso ao
 * /pdv, /retaguarda etc. Se a mesma chave passasse pro app cliente, um
 * operador podería bater nos endpoints do app — confusão de escopo.
 *
 * Anexa req.customer = { id, cpf, name } pra controllers usarem.
 */
@Injectable()
export class CustomerJwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth = req.headers['authorization'] as string | undefined;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token ausente');
    }
    const token = auth.slice(7);
    try {
      const payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
      if (payload.scope !== 'customer') {
        throw new UnauthorizedException('Token inválido pra app cliente');
      }
      req.customer = {
        id: payload.sub,
        cpf: payload.cpf,
        name: payload.name,
      };
      return true;
    } catch (err: any) {
      if (err?.message?.includes('Token inválido')) throw err;
      throw new UnauthorizedException('Token expirado ou inválido');
    }
  }
}
