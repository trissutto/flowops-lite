import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';
import { PrismaService } from '../prisma/prisma.service';

class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(6) password: string;
}

class ChangePasswordDto {
  @IsString() @MinLength(1) oldPassword: string;
  @IsString() @MinLength(8) newPassword: string;
}

class ImpersonateStoreDto {
  @IsString() @MinLength(1) storeCode: string;
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
   * Troca senha do usuario logado.
   * Body: { oldPassword, newPassword (min 8 chars) }
   */
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword({
      userId: req.user.userId || req.user.sub,
      oldPassword: dto.oldPassword,
      newPassword: dto.newPassword,
    });
  }

  /**
   * Admin/master entra como uma loja especifica pra usar o PDV sem deslogar.
   * Retorna { accessToken, user } com role=store e storeCode/storeId da loja.
   * Token tem validade de 8h e carrega flag `impersonatedBy` no payload.
   */
  @UseGuards(JwtAuthGuard)
  @Post('impersonate-store')
  async impersonateStore(@Req() req: any, @Body() dto: ImpersonateStoreDto) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master') {
      throw new ForbiddenException('Apenas admin/master pode entrar como loja');
    }
    const adminUserId = req.user.userId || req.user.sub;
    return this.auth.impersonateStore(adminUserId, dto.storeCode);
  }

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
      impersonatedBy: u.impersonatedBy ?? null,
      impersonatedByEmail: u.impersonatedByEmail ?? null,
      impersonatedByName: u.impersonatedByName ?? null,
    };
  }
}
