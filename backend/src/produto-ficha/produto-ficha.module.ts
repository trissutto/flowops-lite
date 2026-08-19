import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { AtributosPecaModule } from '../atributos-peca/atributos-peca.module';
import { LojaCatalogModule } from '../loja-catalog/loja-catalog.module';
import { ProdutoFichaService } from './produto-ficha.service';
import { FichaIaService } from './ficha-ia.service';
import { ProdutoFichaController } from './produto-ficha.controller';

/**
 * Ficha do produto — a camada de enriquecimento que a tela master edita.
 * Depende do AtributosPecaModule pra resolver tecido/coleção/ocasião/modelagem
 * pelo cadastro em vez de confiar no texto que vem do navegador.
 *
 * `HttpModule` entra pela extração por IA (`FichaIaService`), que lê a
 * descrição existente e devolve os campos preenchidos.
 *
 * `LojaCatalogModule` entra pra DERRUBAR O CACHE do catálogo quando a ficha
 * muda (o que a tela master salva é o que a vitrine mostra). Aresta conferida
 * contra ciclo: `LojaCatalogModule` importa Prisma/Http/Live/PromoSite e nada
 * nesse ramo importa a ficha — só `app.module` e `site-content-editor` fazem.
 */
@Module({
  imports: [PrismaModule, AtributosPecaModule, HttpModule, LojaCatalogModule],
  providers: [ProdutoFichaService, FichaIaService],
  controllers: [ProdutoFichaController],
  exports: [ProdutoFichaService],
})
export class ProdutoFichaModule {}
