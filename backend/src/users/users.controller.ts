import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { UsersService, UserInput } from './users.service';

/**
 * Gerenciamento de usuários. Só admin pode acessar.
 * A verificação é feita via req.user.role (populado pelo JwtStrategy).
 */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  private assertAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin') {
      throw new ForbiddenException('Acesso restrito a administradores');
    }
  }

  @Get()
  list(@Req() req: any) {
    this.assertAdmin(req);
    return this.users.list();
  }

  @Post()
  create(@Req() req: any, @Body() body: UserInput) {
    this.assertAdmin(req);
    return this.users.create(body);
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: UserInput) {
    this.assertAdmin(req);
    return this.users.update(id, body, req.user?.userId);
  }

  @Patch(':id/password')
  changePassword(@Req() req: any, @Param('id') id: string, @Body() body: { password: string }) {
    this.assertAdmin(req);
    return this.users.changePassword(id, body?.password);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string) {
    this.assertAdmin(req);
    return this.users.remove(id, req.user?.userId);
  }
}
