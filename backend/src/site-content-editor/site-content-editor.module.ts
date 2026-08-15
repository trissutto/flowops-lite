import { Module } from '@nestjs/common';
import { ProdutoFichaModule } from '../produto-ficha/produto-ficha.module';
import { SiteContentEditorController } from './site-content-editor.controller';
import { SiteContentEditorService } from './site-content-editor.service';

@Module({
  imports: [ProdutoFichaModule],
  controllers: [SiteContentEditorController],
  providers: [SiteContentEditorService],
  exports: [SiteContentEditorService],
})
export class SiteContentEditorModule {}
