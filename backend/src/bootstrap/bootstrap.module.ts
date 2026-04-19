import { Module } from '@nestjs/common';
import { BootstrapSeedService } from './bootstrap-seed.service';

@Module({
  providers: [BootstrapSeedService],
})
export class BootstrapModule {}
