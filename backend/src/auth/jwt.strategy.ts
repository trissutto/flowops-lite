import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  // Cache em memória pra não bater Prisma em toda request — { storeId → {code,name} }
  private storeCache = new Map<string, { code: string; name: string }>();

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: any) {
    let storeCode = payload.storeCode;
    let storeName = payload.storeName;

    // Tokens emitidos ANTES do fix (que adicionou storeCode/storeName ao payload)
    // só carregam storeId. Faz lookup transparente pra evitar exigir relogar
    // toda a rede assim que esse fix sobe.
    if (payload.storeId && !storeCode) {
      const cached = this.storeCache.get(payload.storeId);
      if (cached) {
        storeCode = cached.code;
        storeName = cached.name;
      } else {
        try {
          const store = await this.prisma.store.findUnique({
            where: { id: payload.storeId },
            select: { code: true, name: true },
          });
          if (store) {
            storeCode = store.code;
            storeName = store.name;
            this.storeCache.set(payload.storeId, { code: store.code, name: store.name });
          }
        } catch {
          // Falha de DB — mantém undefined, controller vai dar mensagem clara
        }
      }
    }

    return {
      // Mantém ambos pra compatibilidade com controllers que usam req.user.sub
      // (PDV, cash, devolução) e os que usam req.user.userId (rotas mais antigas).
      sub: payload.sub,
      userId: payload.sub,
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      storeId: payload.storeId,
      storeCode,
      storeName,
    };
  }
}
