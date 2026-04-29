/**
 * daily-quote.ts — Frase motivacional do dia.
 *
 * Banco curado misturando: foco em varejo, vendas, empreendedorismo, moda
 * plus size, autoestima feminina e produtividade. Determinístico pela data
 * (mesma frase pro dia inteiro, troca à meia-noite local).
 */

export type Quote = { text: string; author?: string };

const QUOTES: Quote[] = [
  // === Varejo / vendas ===
  { text: 'A melhor venda é a que volta amanhã.', author: 'Walmart Way' },
  { text: 'Cliente bem atendido vira propaganda gratuita.' },
  { text: 'Quem mede, melhora. Quem não mede, adivinha.', author: 'Peter Drucker' },
  { text: 'Não se sobe escada olhando pro topo — degrau por degrau.' },
  { text: 'O segredo do varejo: estoque certo, preço certo, hora certa.' },
  { text: 'Cada peça encalhada é um espelho do erro de compra.' },
  { text: 'A loja física vence pelo abraço; o e-commerce, pela conveniência. Ofereça os dois.' },

  // === Empreendedorismo ===
  { text: 'Feito é melhor que perfeito.', author: 'Sheryl Sandberg' },
  { text: 'A maior ineficiência é fazer com excelência o que não devia ser feito.', author: 'Peter Drucker' },
  { text: 'Não tente ter razão. Tente ter resultado.' },
  { text: 'Cuide do seu cliente, ou seu concorrente cuidará.', author: 'Bob Hooey' },
  { text: 'Quem não sabe pra onde vai, qualquer caminho serve.', author: 'Lewis Carroll' },
  { text: 'Comece onde você está. Use o que você tem. Faça o que você pode.', author: 'Arthur Ashe' },
  { text: 'A diferença entre os que sonham e os que fazem é uma planilha.' },
  { text: 'Pequenos detalhes constroem grandes marcas.' },
  { text: 'Foque no problema, não na solução. A solução aparece sozinha.' },

  // === Moda + autoestima ===
  { text: 'Moda passa, estilo permanece.', author: 'Yves Saint Laurent' },
  { text: 'Curva é arquitetura. Não se esconde — se valoriza.' },
  { text: 'Plus size é pra ser plus em tudo: presença, estilo, atitude.' },
  { text: 'Vista a peça que te faz sair de casa sorrindo.' },
  { text: 'Roupa boa é a que te abraça antes do espelho.' },
  { text: 'Confiança é o melhor acessório.' },
  { text: 'Mulher bem vestida começa o dia com ponto a mais.' },

  // === Liderança / time ===
  { text: 'Lidere pelo exemplo — é o único exemplo que dura.' },
  { text: 'Time motivado vende mais que campanha promocional.' },
  { text: 'Treine sua equipe pra te demitir do operacional.' },
  { text: 'Reconheça em público. Corrija em particular.' },
  { text: 'Cultura come estratégia no café da manhã.', author: 'Peter Drucker' },
  { text: 'A vendedora que confia no produto vende três vezes mais.' },

  // === Foco / produtividade ===
  { text: 'Não tente fazer tudo. Faça o que importa.' },
  { text: 'Disciplina pesa gramas; arrependimento pesa toneladas.' },
  { text: 'Cada "não" hoje é espaço pra um "sim" maior amanhã.' },
  { text: 'Produtividade é fazer o certo, não fazer mais.' },
  { text: 'Energia é finita. Gaste com o que vale.' },
  { text: 'O urgente sempre rouba o lugar do importante. Cuidado.' },

  // === Mindset ===
  { text: 'Você não controla o vento, mas pode ajustar as velas.' },
  { text: 'Crescimento mora fora da zona de conforto.' },
  { text: 'O bom é inimigo do ótimo. O ótimo é inimigo do feito.' },
  { text: 'Cada cliente que volta pagou pelo marketing do mês.' },
  { text: 'Erre rápido. Aprenda mais rápido ainda.' },
  { text: 'Plano sem ação é só desejo bonito.' },
  { text: 'A pressa do urgente engole o tempo do importante.' },
  { text: 'Você é a média das 5 pessoas com quem mais convive.', author: 'Jim Rohn' },

  // === Brasileiríssimas ===
  { text: 'Em terra de fila grande, quem entrega rápido reina.' },
  { text: 'Brasileiro compra com o coração — mas só volta com a razão satisfeita.' },
  { text: 'Quem corre por gostar não cansa.' },
  { text: 'Vento bom só ajuda quem já tá remando.' },
  { text: 'O cliente quer ser surpreendido — não enganado.' },

  // === Reflexão ===
  { text: 'Os dias bons fazem você feliz; os ruins fazem você crescer.' },
  { text: 'Não compare seu capítulo 1 com o capítulo 20 do outro.' },
  { text: 'Quem reclama vira espectador. Quem age vira protagonista.' },
  { text: 'Resultado é a soma de pequenas decisões repetidas.' },
  { text: 'Hoje é o melhor dia pra começar o que você adiou.' },
  { text: 'Otimismo é uma escolha, não uma sorte.' },
  { text: 'Foco não é sobre o que fazer — é sobre o que NÃO fazer.', author: 'Steve Jobs' },
  { text: 'Comece o dia com gratidão. O resto se ajusta.' },

  // === Plus extra ===
  { text: 'Lurd\'s não veste corpo — veste atitude.' },
  { text: 'Atendimento é o produto que ninguém copia.' },
  { text: 'Promoção atrai. Experiência fideliza.' },
  { text: 'Estoque parado é dinheiro que dorme.' },
  { text: 'O Brasil tem mais de 70 milhões de mulheres plus size. Quantas são suas clientes?' },
];

/**
 * Hash determinístico simples baseado em data → mesma frase pro dia todo.
 * Troca à meia-noite local (timezone do navegador).
 */
export function getDailyQuote(date = new Date()): Quote {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  // Fórmula simples — espalha bem o módulo entre os dias do ano.
  const seed = y * 372 + m * 31 + d;
  const idx = seed % QUOTES.length;
  return QUOTES[idx];
}
