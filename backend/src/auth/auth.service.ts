import { Injectable, UnauthorizedException } from '@nestjs/common';
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
    if (!user || !user.active) throw new UnauthorizedException('Credenciais inválidas');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Credenciais inválidas');

    const payload = { sub: user.id, email: user.email, role: user.role, storeId: user.storeId };
    const accessToken = await this.jwt.signAsync(payload);

    return {
      accessToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, storeId: user.storeId },
    };
  }
}
