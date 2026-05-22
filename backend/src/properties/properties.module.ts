import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { PropertiesService } from './properties.service';
import { PropertiesController } from './properties.controller';

@Module({
  imports: [
    PrismaModule,
    // JwtModule importado aqui porque o /upload-token NÃO pode usar JwtAuthGuard
    // (o helper `upload()` do @vercel/blob/client não permite passar header
    // Authorization custom). A validação do JWT é feita MANUALMENTE no
    // controller, dentro do callback onBeforeGenerateToken do handleUpload.
    // O JWT vem no clientPayload mandado pelo frontend.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [PropertiesController],
  providers: [PropertiesService],
  exports: [PropertiesService],
})
export class PropertiesModule {}
