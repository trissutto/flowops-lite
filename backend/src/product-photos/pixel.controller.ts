import { BadRequestException, Controller, ForbiddenException, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

/**
 * PIXEL PRO CONTA-GOTAS — a mesma foto do R2, servida por nós.
 *
 * POR QUE EXISTE: o bucket não manda `Access-Control-Allow-Origin`. Sem esse
 * cabeçalho o canvas do navegador se recusa a LER a imagem, e o conta-gotas de
 * precisão morre com "não consigo ler o pixel desta foto". Pedir CORS na tag
 * `<img>` é pior ainda: aí a foto nem aparece (foi o que quebrou a galeria da
 * tela master em 03/08). A nossa API já responde com CORS pro CRM, então ela
 * vira a ponte.
 *
 * SEM AUTENTICAÇÃO, de propósito: `<img>` não manda cabeçalho `Authorization`,
 * e o arquivo já é PÚBLICO no bucket — exigir token aqui não protegeria nada e
 * quebraria o único caso de uso.
 *
 * A trava que importa é outra: só passa URL do NOSSO bucket. Proxy aberto é
 * porta de SSRF — alguém pediria `?url=http://169.254.169.254/...` e usaria
 * nosso servidor pra alcançar rede interna.
 */
@Controller('public/foto')
export class PixelController {
  @Get('pixel')
  async pixel(@Query('url') url: string, @Res() res: Response) {
    const publico = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    const alvo = String(url || '');
    if (!publico || !alvo.startsWith(`${publico}/`)) {
      throw new ForbiddenException('URL fora do bucket de fotos da loja');
    }

    const r = await fetch(alvo).catch(() => null);
    if (!r?.ok) throw new BadRequestException('não consegui buscar a imagem');

    const tipo = r.headers.get('content-type') || 'image/jpeg';
    if (!tipo.startsWith('image/')) throw new BadRequestException('isso não é imagem');

    const buffer = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', tipo);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(buffer);
  }
}
