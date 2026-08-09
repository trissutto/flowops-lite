import { of } from 'rxjs';
import {
  FASHION_NCM_CANDIDATES,
  NcmAiClassifierService,
} from './ncm-ai-classifier.service';

describe('NcmAiClassifierService', () => {
  const buildService = (apiKey?: string) => {
    const config = {
      get: jest.fn((key: string) => (key === 'ANTHROPIC_API_KEY' ? apiKey : undefined)),
    };
    const http = {
      get: jest.fn(),
      post: jest.fn(),
    };
    const service = new NcmAiClassifierService(config as any, http as any);
    (service as any).officialTable = {
      codes: new Map(
        FASHION_NCM_CANDIDATES.map((candidate) => [candidate.code, candidate.label]),
      ),
      officiallyValidated: true,
      expiresAt: Date.now() + 60_000,
    };
    return { service, http };
  };

  it('aceita somente o NCM escolhido pela IA que consta na tabela oficial', async () => {
    const { service, http } = buildService('test-key');
    http.post.mockReturnValue(
      of({ data: { content: [{ type: 'text', text: '{"ncm":"62064000"}' }] } }),
    );

    const result = await service.classify({
      ref: '7031',
      descricaoBase: 'BLUSA SOCIAL',
      grupoNome: 'BLUSA',
      subgrupoNome: 'CAMISA',
      tecidoNome: 'VISCOSE',
    });

    expect(result).toMatchObject({
      ncm: '62064000',
      source: 'ia',
      officiallyValidated: true,
    });
  });

  it('rejeita código inventado pela IA e usa uma regra com código válido', async () => {
    const { service, http } = buildService('test-key');
    http.post.mockReturnValue(
      of({ data: { content: [{ type: 'text', text: '{"ncm":"99999999"}' }] } }),
    );

    const result = await service.classify({
      descricaoBase: 'VESTIDO VISCOSE',
      grupoNome: 'VESTIDO',
      tecidoNome: 'VISCOSE',
    });

    expect(result).toMatchObject({ ncm: '62044400', source: 'regra' });
  });

  it('mantém a entrada funcionando com fallback válido quando a IA está sem chave', async () => {
    const { service, http } = buildService();

    const result = await service.classify({
      descricaoBase: 'CALÇA JEANS',
      grupoNome: 'CALÇA',
      tecidoNome: 'JEANS',
    });

    expect(result).toMatchObject({ ncm: '62046200', source: 'regra' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('preserva um NCM existente que continua vigente', async () => {
    const { service, http } = buildService('test-key');

    const result = await service.classify({
      existingNcm: '6109.10.00',
      descricaoBase: 'CAMISETA',
    });

    expect(result).toMatchObject({ ncm: '61091000', source: 'existente' });
    expect(http.post).not.toHaveBeenCalled();
  });
});
