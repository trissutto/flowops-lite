import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }
  async validate(payload: any) {
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
      storeCode: payload.storeCode,
      storeName: payload.storeName,
    };
  }
}
