import { Controller, Get, Param } from '@nestjs/common';
import { ReturnsService } from './returns.service';

/**
 * Controller PÚBLICO (SEM JwtAuthGuard) para consulta de vale-troca por código.
 *
 * Por quê existe: o cupom do vale é IMPRESSO pra cliente, e a página de
 * impressão (/minha-loja/pdv/vale-troca/[code]) precisa carregar os dados do
 * vale. Se ela usar o endpoint autenticado (/pdv/devolucao/credito/:code) e a
 * sessão da vendedora expirar, o helper api() faz handleUnauthorized() →
 * redireciona pro /login → e o window.print()/Electron acaba imprimindo a
 * TELA DE LOGIN (bug real: o "vale" saía como um bloco cinza com "E-mail/Senha").
 * O cupom do cliente NÃO pode depender da sessão do operador (e no app Electron
 * a impressão silenciosa nem sempre carrega o token).
 *
 * Segurança: só expõe dados de IMPRESSÃO (código/valor/validade/status/
 * histórico). PII (nome/CPF) é removida — o código TROCA-XXXX é o "segredo"
 * que o cliente porta no cupom.
 */
@Controller('public/vale')
export class ReturnsPublicController {
  constructor(private readonly svc: ReturnsService) {}

  @Get(':code')
  async check(@Param('code') code: string) {
    const info: any = await this.svc.checkCredit(code);
    if (info && typeof info === 'object') {
      delete info.customerCpf;
      delete info.customerName;
    }
    return info;
  }
}
