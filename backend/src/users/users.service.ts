import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

const VALID_ROLES = ['admin', 'operator', 'store'] as const;
type Role = (typeof VALID_ROLES)[number];

export interface UserInput {
  email?: string;
  name?: string;
  role?: string;
  storeId?: string | null;
  password?: string;
  active?: boolean;
}

// Retirei passwordHash do retorno — nunca expor pro frontend
const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  storeId: true,
  active: true,
  createdAt: true,
  store: { select: { id: true, code: true, name: true } },
};

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.user.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      select: USER_SELECT,
    });
  }

  async create(data: UserInput) {
    const email = (data.email || '').trim().toLowerCase();
    const name = (data.name || '').trim();
    const role = (data.role || '').trim() as Role;
    const password = data.password || '';

    if (!email) throw new BadRequestException('Email é obrigatório');
    if (!this.isEmailValid(email)) throw new BadRequestException('Email inválido');
    if (!name) throw new BadRequestException('Nome é obrigatório');
    if (!VALID_ROLES.includes(role)) {
      throw new BadRequestException(`Role inválido. Use: ${VALID_ROLES.join(', ')}`);
    }
    if (password.length < 6) {
      throw new BadRequestException('Senha deve ter no mínimo 6 caracteres');
    }
    if (role === 'store' && !data.storeId) {
      throw new BadRequestException('Usuário "store" precisa de uma loja vinculada');
    }

    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Já existe um usuário com este email');

    if (data.storeId) {
      const store = await this.prisma.store.findUnique({ where: { id: data.storeId } });
      if (!store) throw new BadRequestException('Loja selecionada não existe');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    return this.prisma.user.create({
      data: {
        email,
        name,
        role,
        storeId: data.storeId || null,
        passwordHash,
        active: data.active ?? true,
      },
      select: USER_SELECT,
    });
  }

  async update(id: string, data: UserInput, requesterUserId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    // Se tá trocando o email, verifica unicidade
    if (data.email && data.email.trim().toLowerCase() !== user.email) {
      const newEmail = data.email.trim().toLowerCase();
      if (!this.isEmailValid(newEmail)) throw new BadRequestException('Email inválido');
      const conflict = await this.prisma.user.findUnique({ where: { email: newEmail } });
      if (conflict) throw new ConflictException('Já existe um usuário com este email');
    }

    // Role validation
    if (data.role && !VALID_ROLES.includes(data.role as Role)) {
      throw new BadRequestException(`Role inválido. Use: ${VALID_ROLES.join(', ')}`);
    }

    // Não deixa o próprio admin virar não-admin ou se desativar (trava de segurança)
    if (requesterUserId && requesterUserId === id) {
      if (data.role && data.role !== user.role) {
        throw new ForbiddenException('Você não pode alterar o próprio papel. Peça a outro admin.');
      }
      if (data.active === false) {
        throw new ForbiddenException('Você não pode desativar a si mesmo.');
      }
    }

    // Se virando store, precisa de storeId
    const newRole = (data.role ?? user.role) as Role;
    const newStoreId = data.storeId !== undefined ? data.storeId : user.storeId;
    if (newRole === 'store' && !newStoreId) {
      throw new BadRequestException('Usuário "store" precisa de uma loja vinculada');
    }

    if (data.storeId) {
      const store = await this.prisma.store.findUnique({ where: { id: data.storeId } });
      if (!store) throw new BadRequestException('Loja selecionada não existe');
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        email: data.email ? data.email.trim().toLowerCase() : undefined,
        name: data.name !== undefined ? data.name.trim() : undefined,
        role: data.role ?? undefined,
        storeId: data.storeId !== undefined ? (data.storeId || null) : undefined,
        active: data.active ?? undefined,
      },
      select: USER_SELECT,
    });
  }

  async changePassword(id: string, password: string) {
    if (!password || password.length < 6) {
      throw new BadRequestException('Senha deve ter no mínimo 6 caracteres');
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
    return { ok: true };
  }

  /**
   * Desativa o usuário (soft delete). Se não tem histórico vinculado, hard delete.
   * Nunca deixa apagar o próprio usuário logado.
   */
  async remove(id: string, requesterUserId?: string) {
    if (requesterUserId && requesterUserId === id) {
      throw new ForbiddenException('Você não pode remover a si mesmo.');
    }

    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const historyCount = await this.prisma.orderHistory.count({ where: { userId: id } });

    if (historyCount > 0) {
      await this.prisma.user.update({ where: { id }, data: { active: false } });
      return {
        deleted: false,
        deactivated: true,
        reason: `Usuário tem ${historyCount} registro(s) no histórico, apenas desativado.`,
      };
    }

    await this.prisma.user.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }

  private isEmailValid(email: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}
