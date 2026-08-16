import { montarJornada, sanitizarDadosEvento, SiteMetricsService } from './site-metrics.service';

describe('sanitizarDadosEvento', () => {
  it('mantém apenas campos diagnósticos permitidos', () => {
    expect(sanitizarDadosEvento('checkout_error', {
      method: 'card', reason: 'api_rejected', email: 'cliente@exemplo.com', cardToken: 'segredo',
    })).toEqual({ method: 'card', reason: 'api_rejected' });
  });

  it('preserva a causa fechada sem persistir a mensagem do gateway', () => {
    expect(sanitizarDadosEvento('checkout_error', {
      method: 'card', reason: 'card_declined', gatewayMessage: 'do not honor', cpf: '123',
    })).toEqual({ method: 'card', reason: 'card_declined' });
  });

  it('descarta dados de eventos sem contrato diagnóstico', () => {
    expect(sanitizarDadosEvento('page_view', { email: 'cliente@exemplo.com' })).toBeUndefined();
  });

  it('limita valores para evitar payload e cardinalidade sem controle', () => {
    expect(sanitizarDadosEvento('add_to_cart_blocked', { reason: 'x'.repeat(200) }))
      .toEqual({ reason: 'x'.repeat(80) });
  });

  it('registra só seção e nome do campo inválido, nunca o valor', () => {
    expect(sanitizarDadosEvento('checkout_validation_error', {
      section: 'identification', field: 'cpf', value: '123.456.789-00',
    })).toEqual({ section: 'identification', field: 'cpf' });
  });

  /**
   * O UTM não pertence a evento nenhum — viaja em todos. Enquanto a lista era
   * só por evento, `page_view` não tinha entrada, `permitidos` era `[]` e a
   * campanha inteira era descartada em silêncio: o quadro "por campanha"
   * respondia "sem campanha" pra todo mundo e a cláusula que protege tráfego
   * pago do corte de robô (`dados ? 'campanha'`) era letra morta.
   */
  it('guarda a origem da visita em QUALQUER evento, inclusive page_view', () => {
    expect(sanitizarDadosEvento('page_view', {
      campanha: 'inverno26', canal: 'meta', midia: 'cpc', posicao: 'feed', utm_id: '123',
    })).toEqual({ campanha: 'inverno26', canal: 'meta', midia: 'cpc', posicao: 'feed', utm_id: '123' });
  });

  it('guarda a marca de clique pago junto com o diagnóstico do evento', () => {
    expect(sanitizarDadosEvento('add_to_cart_blocked', {
      reason: 'size_missing', pago: true, plataforma: 'google', campanha: 'inverno26',
    })).toEqual({ reason: 'size_missing', pago: 'true', plataforma: 'google', campanha: 'inverno26' });
  });

  it('guarda as REFs, que são lista e não passavam pelo filtro de escalar', () => {
    expect(sanitizarDadosEvento('view_item', { refs: ['VST-001', 'VST-002', 7, ''] }))
      .toEqual({ refs: ['VST-001', 'VST-002'] });
  });

  it('continua barrando PII mesmo quando ela vem junto da campanha', () => {
    expect(sanitizarDadosEvento('page_view', {
      campanha: 'inverno26', email: 'cliente@exemplo.com', cpf: '123', telefone: '11999999999',
    })).toEqual({ campanha: 'inverno26' });
  });
});

describe('montarJornada', () => {
  it('conta cada sessão apenas na etapa máxima e reconstrói etapas ausentes', () => {
    const jornada = montarJornada([
      { etapaMaxima: 0, pessoas: 2 },
      { etapaMaxima: 2, pessoas: 3 },
      { etapaMaxima: 5, pessoas: 1 },
    ]);

    expect(jornada[0]).toMatchObject({ chegaram: 6, avancaram: 4, abandonaram: 2 });
    expect(jornada[1]).toMatchObject({ chegaram: 4, avancaram: 4, abandonaram: 0 });
    expect(jornada[2]).toMatchObject({ chegaram: 4, avancaram: 1, abandonaram: 3 });
    expect(jornada[5]).toMatchObject({ chegaram: 1, avancaram: null, abandonaram: 0 });
  });

  it('não inventa percentuais quando a etapa não tem base', () => {
    const jornada = montarJornada([]);
    expect(jornada.every((linha) => linha.chegaram === 0)).toBe(true);
    expect(jornada.every((linha) => linha.taxaAvanco === null && linha.taxaPerda === null)).toBe(true);
  });

  it('soma grupos repetidos da mesma etapa sem perder pessoas', () => {
    const jornada = montarJornada([
      { etapaMaxima: 1, pessoas: 5 },
      { etapaMaxima: 1, pessoas: 2 },
      { etapaMaxima: 2, pessoas: 1 },
    ]);
    expect(jornada[1]).toMatchObject({ chegaram: 8, avancaram: 1, abandonaram: 7 });
  });
});

describe('jornadaCompra', () => {
  it('separa falha recuperada e Pix pendente sem inflar a jornada', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        { etapa_maxima: 0, pessoas: 2 },
        { etapa_maxima: 5, pessoas: 1 },
      ])
      .mockResolvedValueOnce([
        { evento: 'checkout_error', codigo: 'api_rejected', campo: null, pessoas: 2, ocorrencias: 3, recuperadas: 1 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { sessoes_problema: 2, sessoes_recuperadas: 1, pix_pendente: 1 },
      ]);
    const service = new SiteMetricsService({ $queryRawUnsafe: query } as any);

    const resultado = await service.jornadaCompra(new Date('2026-08-16T00:00:00-03:00'), new Date('2026-08-16T23:59:59-03:00'));

    expect(resultado.jornada[0]).toMatchObject({ chegaram: 3, avancaram: 1, abandonaram: 2 });
    expect(resultado.problemas[0]).toMatchObject({ pessoas: 2, ocorrencias: 3, recuperadas: 1 });
    expect(resultado.resumo).toMatchObject({ sessoesComProblema: 2, sessoesRecuperadas: 1, pixPendente: 1 });
    expect(String(query.mock.calls[1][0])).toContain("e.evento <> 'payment_retry'");
    expect(String(query.mock.calls[3][0])).toContain("NOT EXISTS");
    expect(String(query.mock.calls[3][0])).toContain("c.evento = 'purchase'");
  });

  /**
   * A REGRESSÃO QUE ESTE TESTE EXISTE PRA IMPEDIR (16/08/2026): a jornada
   * rodava sem o corte de robô que o `funil()` — logo acima dela na MESMA tela
   * — já aplicava. O topo do funil vinha inflado de varredura de catálogo
   * (cada página aberta por robô com JS vira uma sessão nova), e o quadro
   * "MAIOR PERDA" acusava 96% de abandono em "Produto visto" que era robô.
   */
  it('aplica o corte de robô e de sessão-de-gente em TODAS as queries da jornada', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new SiteMetricsService({ $queryRawUnsafe: query } as any);

    await service.jornadaCompra(new Date(), new Date());

    expect(query).toHaveBeenCalledTimes(4);
    for (const [sql] of query.mock.calls) {
      expect(String(sql)).toContain('WITH gente AS (');
      expect(String(sql)).toMatch(/NOT \w+\.bot AND \w+\.session_id IN \(SELECT session_id FROM gente\)/);
    }
  });

  /**
   * CTE DECLARADA DUAS VEZES DERRUBA A TELA INTEIRA (16/08/2026).
   *
   * As CTEs desta tela são montadas por interpolação de constante, então uma
   * duplicata é sintaticamente invisível no TypeScript: compila, passa nos
   * testes que conferem CONTEÚDO da string, e o Postgres recusa a query só em
   * produção — `WITH query name "x" specified more than once`. Foi o que
   * aconteceu quando o segmento entrou na `jornadaCompra`: as quatro queries
   * nasceram com `segmento` declarada duas vezes e o endpoint do funil passou
   * a responder 500, deixando a tela com cara de dia sem movimento.
   *
   * Vale pra qualquer CTE, não só a do segmento: o risco é a montagem por
   * string, e ela não vai deixar de existir.
   */
  it('não declara a mesma CTE duas vezes em nenhuma query da tela', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new SiteMetricsService({ $queryRawUnsafe: query } as any);
    const seg = { trafego: 'pago' as const, plataforma: 'meta', campanha: 'c1' };

    await service.funil(new Date(), new Date(), seg);
    await service.jornadaCompra(new Date(), new Date(), seg);
    await service.diagnosticosFunil(new Date(), new Date(), seg);
    await service.alertasCheckout(new Date(), new Date(), seg);
    await service.trafegoDeLojas(new Date(), new Date(), seg);
    await service.segmentosDisponiveis(new Date(), new Date());

    expect(query.mock.calls.length).toBeGreaterThan(0);
    for (const [sql] of query.mock.calls) {
      // `nome AS (` só aparece em declaração de CTE — alias de coluna é
      // `AS nome`, e tabela derivada fecha com `) nome`, sem o AS.
      const nomes = [...String(sql).matchAll(/\b([a-z_]+) AS \(/g)].map((m) => m[1]);
      const repetidas = nomes.filter((n, i) => nomes.indexOf(n) !== i);
      expect(repetidas).toEqual([]);
    }
  });

  /**
   * `view_item` dispara sozinho no `useEffect` de montagem do BuyBox da PDP —
   * não é ação de ninguém. Enquanto ele contou como "sinal de gente", todo
   * scraper que abria uma peça era promovido a pessoa: "Produto visto" chegou
   * a 97% das sessões (419 de 432) e a perda da Visita caiu pra 3%. Se este
   * teste cair, o relatório volta a certificar robô como cliente exatamente
   * na etapa que ele precisa medir.
   */
  it('não aceita evento automático (page_view/view_item) como prova de que é gente', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new SiteMetricsService({ $queryRawUnsafe: query } as any);

    await service.jornadaCompra(new Date(), new Date());

    for (const [sql] of query.mock.calls) {
      expect(String(sql)).toContain("evento NOT IN ('page_view','view_item')");
      expect(String(sql)).not.toContain("evento <> 'page_view'");
    }
  });

  /**
   * Rejeição relâmpago de tráfego pago é o sintoma nº 1 de anúncio prometendo
   * o que a página não entrega (dono, 16/08). Se a régua apagar essa sessão
   * como robô, a tela esconde dinheiro sendo queimado — o pior tipo de erro de
   * medição que existe. Clique em anúncio é ação humana por definição.
   */
  it('nunca corta quem chegou por link identificado, mesmo sem rolar nem ficar 3s', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new SiteMetricsService({ $queryRawUnsafe: query } as any);

    await service.jornadaCompra(new Date(), new Date());

    for (const [sql] of query.mock.calls) {
      expect(String(sql)).toContain("dados ? 'campanha' OR dados ? 'canal'");
      // `midia` vale 'direct' pra todo mundo sem referrer — usá-la aqui
      // devolveria o robô inteiro pra dentro da conta.
      expect(String(sql)).not.toContain("dados ? 'midia'");
    }
  });

  it('corta robô também no diagnóstico e no alerta de checkout da mesma tela', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new SiteMetricsService({ $queryRawUnsafe: query } as any);

    await service.diagnosticosFunil(new Date(), new Date());
    await service.alertasCheckout(new Date(), new Date());

    for (const [sql] of query.mock.calls) {
      expect(String(sql)).toContain('WITH gente AS (');
      expect(String(sql)).toContain('IN (SELECT session_id FROM gente)');
    }
  });

  it('não cria maior perda nem alerta de amostra quando não há sessões', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = new SiteMetricsService({ $queryRawUnsafe: query } as any);

    const resultado = await service.jornadaCompra(new Date(), new Date());

    expect(resultado.resumo.maiorPerda).toBeNull();
    expect(resultado.resumo.amostraPequena).toBe(true);
    expect(resultado.jornada.every((linha) => linha.chegaram === 0)).toBe(true);
  });
});

describe('montarJornada', () => {
  it('conta cada sessão apenas na etapa máxima e reconstrói etapas ausentes', () => {
    const jornada = montarJornada([
      { etapaMaxima: 0, pessoas: 2 },
      { etapaMaxima: 2, pessoas: 3 },
      { etapaMaxima: 5, pessoas: 1 },
    ]);

    expect(jornada[0]).toMatchObject({ chegaram: 6, avancaram: 4, abandonaram: 2 });
    expect(jornada[1]).toMatchObject({ chegaram: 4, avancaram: 4, abandonaram: 0 });
    expect(jornada[2]).toMatchObject({ chegaram: 4, avancaram: 1, abandonaram: 3 });
    expect(jornada[5]).toMatchObject({ chegaram: 1, avancaram: null, abandonaram: 0 });
  });

  it('não inventa percentuais quando a etapa não tem base', () => {
    const jornada = montarJornada([]);
    expect(jornada.every((linha) => linha.chegaram === 0)).toBe(true);
    expect(jornada.every((linha) => linha.taxaAvanco === null && linha.taxaPerda === null)).toBe(true);
  });

  it('soma grupos repetidos da mesma etapa sem perder pessoas', () => {
    const jornada = montarJornada([
      { etapaMaxima: 1, pessoas: 5 },
      { etapaMaxima: 1, pessoas: 2 },
      { etapaMaxima: 2, pessoas: 1 },
    ]);
    expect(jornada[1]).toMatchObject({ chegaram: 8, avancaram: 1, abandonaram: 7 });
  });
});

describe('jornadaCompra', () => {
  it('separa falha recuperada e Pix pendente sem inflar a jornada', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        { etapa_maxima: 0, pessoas: 2 },
        { etapa_maxima: 5, pessoas: 1 },
      ])
      .mockResolvedValueOnce([
        { evento: 'checkout_error', codigo: 'api_rejected', campo: null, pessoas: 2, ocorrencias: 3, recuperadas: 1 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { sessoes_problema: 2, sessoes_recuperadas: 1, pix_pendente: 1 },
      ]);
    const service = new SiteMetricsService({ $queryRawUnsafe: query } as any);

    const resultado = await service.jornadaCompra(new Date('2026-08-16T00:00:00-03:00'), new Date('2026-08-16T23:59:59-03:00'));

    expect(resultado.jornada[0]).toMatchObject({ chegaram: 3, avancaram: 1, abandonaram: 2 });
    expect(resultado.problemas[0]).toMatchObject({ pessoas: 2, ocorrencias: 3, recuperadas: 1 });
    expect(resultado.resumo).toMatchObject({ sessoesComProblema: 2, sessoesRecuperadas: 1, pixPendente: 1 });
    expect(String(query.mock.calls[1][0])).toContain("e.evento <> 'payment_retry'");
    expect(String(query.mock.calls[3][0])).toContain("NOT EXISTS");
    expect(String(query.mock.calls[3][0])).toContain("c.evento = 'purchase'");
  });

  it('não cria maior perda nem alerta de amostra quando não há sessões', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = new SiteMetricsService({ $queryRawUnsafe: query } as any);

    const resultado = await service.jornadaCompra(new Date(), new Date());

    expect(resultado.resumo.maiorPerda).toBeNull();
    expect(resultado.resumo.amostraPequena).toBe(true);
    expect(resultado.jornada.every((linha) => linha.chegaram === 0)).toBe(true);
  });
});
