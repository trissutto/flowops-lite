import { BadRequestException } from '@nestjs/common';
import { PromoConfigService } from './promo-config.service';

/**
 * Gravar a campanha: os campos novos (palavras que excluem, grupos e
 * subgrupos) passam pela mesma trava ALTA dos termos — nada é corrigido calado
 * num lugar que mexe no preço da rede inteira.
 */
describe('PromoConfigService — gravar a campanha', () => {
  function montar() {
    let row: any = null;
    const prisma: any = {
      appConfig: {
        findUnique: jest.fn(async () => row),
        upsert: jest.fn(async ({ create, update }: any) => { row = { valueJson: (row ? update : create).valueJson }; return row; }),
      },
    };
    return new PromoConfigService(prisma);
  }

  it('grava exclusões, grupos e subgrupos normalizados e devolve a campanha inteira', async () => {
    const svc = montar();
    const r = await svc.setConfig(
      { campanha: { termosExclusao: ['bermuda', '22 de abril'], grupos: [97, '13' as any], subgrupos: [53] } },
      'Matriz',
    );
    expect(r.campanha).toMatchObject({
      nome: 'Inverno', pct: 30, termosExclusao: ['BERMUDA', '22 DE ABRIL'], grupos: [13, 97], subgrupos: [53], atualizadaPor: 'Matriz',
    });
    svc.clearCache();
    expect((await svc.getConfig()).campanha.grupos).toEqual([13, 97]);
  });

  it('linha BÁSICA fora é o padrão; só desliga com false explícito', async () => {
    const svc = montar();
    expect((await svc.getConfig()).campanha.excluirBasico).toBe(true);
    expect((await svc.setConfig({ campanha: { pct: 30 } })).campanha.excluirBasico).toBe(true);
    expect((await svc.setConfig({ campanha: { excluirBasico: false } })).campanha.excluirBasico).toBe(false);
  });

  it('recusa grupo/subgrupo nulo ou vazio — viraria o subgrupo 0, que existe', async () => {
    const svc = montar();
    await expect(svc.setConfig({ campanha: { subgrupos: [null as any] } })).rejects.toThrow(BadRequestException);
    await expect(svc.setConfig({ campanha: { grupos: ['' as any] } })).rejects.toThrow(/Grupo inválido/);
  });

  it('recusa palavra que exclui que não pega nada (só conectivo)', async () => {
    const svc = montar();
    await expect(svc.setConfig({ campanha: { termosExclusao: ['DE'] } })).rejects.toThrow(/Palavra que exclui/);
  });
});
