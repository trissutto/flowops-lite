# Ofertas verificáveis e nomes com referência

## Objetivo

Eliminar ofertas ambíguas na vitrine e facilitar a identificação da peça pela cliente e pelo atendimento.

## Regras

- O selo **Promoção**, o preço anterior riscado e o percentual aparecem somente quando o preço anterior é numérico, positivo e maior que o preço atual.
- Uma seleção comercial marcada como promocional, mas sem economia calculável, recebe o selo **Preço especial**.
- Um preço anterior inválido nunca é repassado aos componentes.
- Nome e referência formam um único título no padrão `Nome curto — REFERÊNCIA`, sem duplicar a referência quando o cadastro já a contém.
- O mesmo nome composto segue para card, página do produto, adição rápida, carrinho, pedido e atendimento.

## Implementação

A decisão comercial fica em funções puras e testáveis. Os dois adaptadores de catálogo aplicam a mesma regra antes de criar o `Product`. O card remove duplicidade do selo de promoção e as telas deixam de repetir uma segunda linha de referência, pois ela passa a fazer parte do título identificável.

## Validação

Testes unitários cobrem desconto válido, seleção comercial sem desconto, ausência de oferta e nome sem referência duplicada. TypeScript, ESLint e a suíte completa do e-commerce validam a integração.
