import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AccessPolicyService } from './access-policy.service';
import { AccessPolicyController, DiscountPolicyController } from './access-policy.controller';

@Module({
  imports: [PrismaModule],
  controllers: [AccessPolicyController, DiscountPolicyController],
  providers: [AccessPolicyService],
  exports: [AccessPolicyService],
})
export class AccessPolicyModule {}
