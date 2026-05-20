import { Module } from '@nestjs/common';
import { DesktopController } from './desktop.controller';

@Module({
  controllers: [DesktopController],
})
export class DesktopModule {}
