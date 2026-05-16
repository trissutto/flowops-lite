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
        // TTL default 24h — vendedora abre app de manhã e só pede login no dia
        // seguinte. Cobre turno duplo (8h-22h) sem expirar no meio.
        // Pra ajustar via env, setar JWT_ACCESS_TTL=Xh no Railway.
        signOptions: { expiresIn: cfg.get<string>('JWT_ACCESS_TTL') ?? '24h' },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy, AdminOnlyGuard],
  controllers: [AuthController],
  exports: [AuthService, AdminOnlyGuard],
})
export class AuthModule {}
