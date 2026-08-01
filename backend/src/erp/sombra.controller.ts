import { Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { SombraService } from './sombra.service';

/**
 * ACOMPANHAMENTO DO MODO SOMBRA — é por aqui que se decide virar a chave.
 *
 * GET /erp/sombra devolve, por método migrado, quantas vezes a consulta nova
 * do Postgres concordou com o Giga e quantas divergiu, com o último caso
 * divergente para reproduzir.
 *
 * O CRITÉRIO DE VIRADA: taxa de 100% por dias seguidos, com volume que cubra
 * o fim de semana e a live — os dois momentos em que aparece dado que a
 * semana normal não produz. Taxa alta com volume baixo não prova nada.
 */
@UseGuards(JwtAuthGuard)
@Controller('erp/sombra')
export class SombraController {
  constructor(private readonly sombra: SombraService) {}

  @Get()
  status(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    const linhas = this.sombra.relatorio();
    return {
      ligado: this.sombra.ligado,
      // Sem a env, o placar fica vazio e a resposta parece "tudo certo" —
      // dizer isso explicitamente evita a conclusão errada.
      aviso: this.sombra.ligado
        ? undefined
        : 'GIGA_SOMBRA nao esta ligada: nenhuma comparacao esta acontecendo.',
      metodos: linhas,
      total: linhas.reduce(
        (acc, l) => ({
          iguais: acc.iguais + l.iguais,
          formato: acc.formato + l.formato,
          diferentes: acc.diferentes + l.diferentes,
          erros: acc.erros + l.erros,
        }),
        { iguais: 0, formato: 0, diferentes: 0, erros: 0 },
      ),
      // Achado da validação offline (31/07): o desempate "quem tem mais
      // estoque" usa `wincred_estoque`, que sincroniza de hora em hora. Em
      // produto duplicado (mesma REF+COR+TAM em códigos diferentes), estoque
      // defasado escolhe outro código. É a causa mais provável de divergência
      // aqui — e some quando o estoque virar nativo (Fase 2/3 do plano).
      nota: 'Divergencia em produto DUPLICADO costuma ser latencia do espelho de estoque (1h), nao erro de traducao.',
    };
  }

  /** Zera o placar — usar ao começar uma janela nova de observação. */
  @Post('zerar')
  zerar(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    this.sombra.zerar();
    return { ok: true };
  }
}
