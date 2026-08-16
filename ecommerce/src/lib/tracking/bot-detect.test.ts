import { describe, expect, it } from 'vitest';

import { detectarRobo } from './bot-detect';

/**
 * O risco desta função não é simétrico.
 *
 * Deixar um robô passar mantém a métrica um pouco suja — chato, e o filtro de
 * comportamento do FlowOps ainda pega. Marcar CLIENTE como robô some com ela
 * da tela em silêncio, e aí o número mente pro outro lado sem ninguém notar.
 * Por isso a metade de baixo deste arquivo (gente de verdade) é a que importa,
 * e é onde entram os navegadores que MAIS trazem venda nesta loja: o de dentro
 * do Instagram e o Safari do iPhone.
 */
describe('detectarRobo', () => {
  describe('robô — tem que pegar', () => {
    const ROBOS: Array<[string, string, string]> = [
      ['googlebot', 'googlebot',
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
      ['googlebot mobile renderizando', 'googlebot',
        'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.76 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
      ['bingbot', 'bingbot',
        'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
      ['GPTBot da OpenAI', 'gptbot',
        'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot'],
      ['ChatGPT abrindo link', 'chatgpt',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot'],
      ['ClaudeBot', 'claudebot',
        'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com'],
      ['PerplexityBot', 'perplexitybot',
        'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)'],
      ['Ahrefs varrendo catálogo', 'ahrefsbot',
        'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'],
      ['SemrushBot', 'semrushbot',
        'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)'],
      ['prévia de link do Facebook', 'facebook-preview',
        'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
      ['prévia de link do WhatsApp', 'whatsapp-preview', 'WhatsApp/2.23.20.0'],
      ['monitor de uptime', 'monitor',
        'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)'],
      ['Chrome headless (scraper)', 'headless',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/125.0.0.0 Safari/537.36'],
      ['script em python', 'script', 'python-requests/2.31.0'],
      ['curl', 'script', 'curl/8.4.0'],
      ['robô fora da lista, mas declarado', 'outro-robo',
        'Mozilla/5.0 (compatible; CoisaBot/1.2; +http://exemplo.com/robo)'],
      ['sem user-agent nenhum', 'sem-user-agent', ''],
    ];

    it.each(ROBOS)('%s', (_titulo, nome, ua) => {
      expect(detectarRobo(ua)).toEqual({ bot: true, nome });
    });

    it('user-agent ausente conta como robô', () => {
      expect(detectarRobo(null).bot).toBe(true);
      expect(detectarRobo(undefined).bot).toBe(true);
    });
  });

  describe('GENTE — não pode marcar como robô de jeito nenhum', () => {
    const PESSOAS: Array<[string, string]> = [
      ['navegador DENTRO do Instagram (o que mais traz venda)',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 336.0.0.25.90 (iPhone13,2; iOS 17_5_1; pt_BR; pt-BR; scale=3.00; 1170x2532; 604402238)'],
      ['navegador dentro do Facebook',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBDV/iPhone14,3;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/pt_BR]'],
      ['Safari do iPhone',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'],
      ['Chrome do Android',
        'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36'],
      ['Chrome do PC da loja',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'],
      ['Edge',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.61'],
      ['Samsung Internet',
        'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36'],
      ['Firefox',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0'],
      ['Safari do Mac',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'],
    ];

    it.each(PESSOAS)('%s', (_titulo, ua) => {
      expect(detectarRobo(ua)).toEqual({ bot: false, nome: null });
    });
  });

  it('não depende de maiúscula/minúscula', () => {
    expect(detectarRobo('GOOGLEBOT/2.1').nome).toBe('googlebot');
  });
});
