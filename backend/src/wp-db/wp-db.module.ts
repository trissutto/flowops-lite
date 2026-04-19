import { Module } from '@nestjs/common';
import { WpDbService } from './wp-db.service';

@Module({
  providers: [WpDbService],
  exports: [WpDbService],
})
export class WpDbModule {}
