import { Body, Controller, Delete, Get, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CarneCoordsService, CarneCoords } from './carne-coords.service';

@UseGuards(JwtAuthGuard)
@Controller('pdv/carne/coords')
export class CarneCoordsController {
  constructor(private readonly svc: CarneCoordsService) {}

  @Get()
  read() {
    return this.svc.read();
  }

  @Put()
  write(@Body() body: Partial<CarneCoords>) {
    return this.svc.write(body);
  }

  @Delete()
  reset() {
    return this.svc.reset();
  }
}
