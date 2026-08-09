import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import {
  normalizePdvSummaryStoreCode,
  PdvStoreSummaryService,
} from './store-summary.service';

export function resolvePdvSummaryStoreCode(user: any, requestedStoreCode?: string): string {
  const role = String(user?.role || '');
  if (role !== 'store' && role !== 'admin') {
    throw new ForbiddenException('Apenas admin ou loja');
  }

  const requested = normalizePdvSummaryStoreCode(requestedStoreCode);
  if (role === 'store') {
    const ownStoreCode = normalizePdvSummaryStoreCode(user?.storeCode);
    if (!ownStoreCode) throw new ForbiddenException('Usuário sem loja vinculada');
    if (requested && requested !== ownStoreCode) {
      throw new ForbiddenException('Acesso negado a outra loja');
    }
    return ownStoreCode;
  }

  if (!requested) throw new BadRequestException('storeCode obrigatório');
  return requested;
}

@UseGuards(JwtAuthGuard)
@Controller('pdv')
export class PdvStoreSummaryController {
  constructor(private readonly summary: PdvStoreSummaryService) {}

  /** Resumo oculto do PDV: peças líquidas do dia + estoque operacional atual. */
  @Get('store-summary')
  getStoreSummary(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
  ) {
    const effectiveStoreCode = resolvePdvSummaryStoreCode(req?.user, storeCode);
    return this.summary.getSummary(effectiveStoreCode);
  }
}
