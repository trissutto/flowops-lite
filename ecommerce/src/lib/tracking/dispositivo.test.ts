import { describe, expect, it } from 'vitest';
import { dispositivoDoUserAgent } from './dispositivo';

describe('dispositivoDoUserAgent', () => {
  it('reconhece celular', () => {
    expect(
      dispositivoDoUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('celular');
    expect(
      dispositivoDoUserAgent(
        'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36',
      ),
    ).toBe('celular');
  });

  it('reconhece o navegador embutido do Instagram e do Facebook', () => {
    // Metade do tráfego vem de paid_social; é este UA que a maioria das
    // sessões carrega. Se ele caísse em "pc", a medição nasceria errada.
    expect(
      dispositivoDoUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 335.0.0.32.99',
      ),
    ).toBe('celular');
    expect(
      dispositivoDoUserAgent(
        'Mozilla/5.0 (Linux; Android 13; moto g22) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/468.0.0.34.107;]',
      ),
    ).toBe('celular');
  });

  it('separa tablet de celular', () => {
    // Android sem "mobile" É tablet — é a regra que faz a ordem dos testes
    // importar dentro do módulo.
    expect(
      dispositivoDoUserAgent(
        'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      ),
    ).toBe('tablet');
    expect(
      dispositivoDoUserAgent(
        'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Safari/604.1',
      ),
    ).toBe('tablet');
  });

  it('reconhece PC', () => {
    expect(
      dispositivoDoUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      ),
    ).toBe('pc');
    expect(
      dispositivoDoUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      ),
    ).toBe('pc');
  });

  it('sem user-agent responde pc, não um quarto valor', () => {
    expect(dispositivoDoUserAgent(undefined)).toBe('pc');
    expect(dispositivoDoUserAgent('')).toBe('pc');
    expect(dispositivoDoUserAgent(null)).toBe('pc');
  });
});
