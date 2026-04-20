import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';
import { PrismaService } from '../prisma/prisma.service';

class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(6) password: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /**
   * Retorna o user logado (pra frontend saber role/storeId após F5 sem relogar).
   * Inclui storeCode + storeName quando é user de loja — usado pelo /minha-loja
   * pra montar título "LURDS ORDER ONE [NOME DA LOJA]".
   */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req: any) {
    const u = req.user;
    let storeCode: string | null = null;
    let storeName: string | null = null;
    if (u.storeId) {
      const store = await this.prisma.store.findUnique({
        where: { id: u.storeId },
        select: { code: true, name: true },
      });
      storeCode = store?.code ?? null;
      storeName = store?.name ?? null;
    }
    return {
      userId: u.userId,
      email: u.email,
      role: u.role,
      storeId: u.storeId,
      storeCode,
      storeName,
    };
  }
}
