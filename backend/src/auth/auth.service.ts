import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.active) throw new UnauthorizedException('Credenciais invalidas');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Credenciais invalidas');

    let storeCode: string | null = null;
    let storeName: string | null = null;
    if (user.storeId) {
      const store = await this.prisma.store.findUnique({
        where: { id: user.storeId },
        select: { code: true, name: true },
      });
      storeCode = store?.code ?? null;
      storeName = store?.name ?? null;
    }

    const payload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      storeId: user.storeId,
      storeCode,
      storeName,
    };
    const accessToken = await this.jwt.signAsync(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        storeId: user.storeId,
        storeCode,
        storeName,
      },
    };
  }

  async changePassword(input: {
    userId: string;
    oldPassword: string;
    newPassword: string;
  }) {
    const oldPwd = String(input.oldPassword || '');
    const newPwd = String(input.newPassword || '');

    if (newPwd.length < 8) {
      throw new BadRequestException('Nova senha precisa ter ao menos 8 caracteres');
    }
    if (oldPwd === newPwd) {
      throw new BadRequestException('A nova senha precisa ser diferente da atual');
    }
    const senhasBloqueadas = ['admin123', '12345678', 'password', 'qwerty123', 'admin1234'];
    if (senhasBloqueadas.includes(newPwd.toLowerCase())) {
      throw new BadRequestException('Senha muito fraca / comum. Escolha algo unico.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (!user.active) throw new UnauthorizedException('Usuario desativado');

    const ok = await bcrypt.compare(oldPwd, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Senha atual incorreta');

    const newHash = await bcrypt.hash(newPwd, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    return { ok: true, message: 'Senha alterada com sucesso. Faca login novamente.' };
  }
}
