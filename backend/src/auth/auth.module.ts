import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { AdminOnlyGuard } from './admin-only.guard';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('JWT_SECRET'),
        // TTL default 12h — bulks longos de separação (40+ pedidos) estouravam
        // o antigo 15m no meio da operação. Sessão de 12h cobre um dia operacional.
        signOptions: { expiresIn: cfg.get<string>('JWT_ACCESS_TTL') ?? '12h' },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy, AdminOnlyGuard],
  controllers: [AuthController],
  exports: [AuthService, AdminOnlyGuard],
})
export class AuthModule {}
