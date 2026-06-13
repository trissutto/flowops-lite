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

  /**
   * Gera um JWT de "loja" pra admin/master operar o PDV daquela loja
   * SEM precisar deslogar. Token tem validade curta (8h) e carrega flag
   * `impersonatedBy` pra auditoria — qualquer rota sensível pode checar
   * isso e bloquear/logar.
   *
   * Caso de uso: Thiago precisa abrir o PDV de Sorocaba pra resolver algo
   * sem pedir senha pra vendedora. Clica "Entrar como loja" em
   * /retaguarda/lojas, abre aba nova já logada.
   */
  async impersonateStore(adminUserId: string, storeCode: string) {
    const admin = await this.prisma.user.findUnique({ where: { id: adminUserId } });
    if (!admin || !admin.active) throw new UnauthorizedException('Admin invalido');
    if (admin.role !== 'admin' && admin.role !== 'master') {
      throw new UnauthorizedException('Apenas admin/master pode impersonar loja');
    }

    const store = await this.prisma.store.findUnique({
      where: { code: storeCode },
      select: { id: true, code: true, name: true, active: true },
    });
    if (!store) throw new NotFoundException(`Loja ${storeCode} nao cadastrada`);
    if (!store.active) throw new BadRequestException(`Loja ${storeCode} esta inativa`);

    const payload = {
      sub: admin.id,
      email: admin.email,
      name: `${admin.name} (como ${store.name})`,
      role: 'store' as const,
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      impersonatedBy: admin.id,
      impersonatedByEmail: admin.email,
      impersonatedByName: admin.name,
    };

    const accessToken = await this.jwt.signAsync(payload, { expiresIn: '8h' });

    // eslint-disable-next-line no-console
    console.log(
      `[IMPERSONATE] ${admin.email} (${admin.id}) entrou como loja ${store.code} (${store.name}) em ${new Date().toISOString()}`,
    );

    return {
      accessToken,
      user: {
        id: admin.id,
        email: admin.email,
        name: payload.name,
        role: 'store',
        storeId: store.id,
        storeCode: store.code,
        storeName: store.name,
        impersonated: true,
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
