import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { StoresService, StoreInput } from './stores.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

@Controller('stores')
@UseGuards(JwtAuthGuard)
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  list() {
    return this.stores.list();
  }

  @Get(':id/performance')
  performance(@Param('id') id: string) {
    return this.stores.performance(id);
  }

  @Post()
  create(@Body() body: StoreInput) {
    return this.stores.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: StoreInput) {
    return this.stores.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.stores.remove(id);
  }
}
