# PR 2 — produto e sacola

- [x] Auditar cor, tamanho, preço, PIX, parcelamento, frete e troca na PDP.
- [x] Auditar CTA móvel e estados bloqueados.
- [x] Auditar persistência, cupom, CEP e frete da sacola.
- [x] Impedir checkout com indisponibilidade de estoque já confirmada.
- [x] Limitar aumento de quantidade ao estoque conhecido.
- [x] Rastrear tamanho escolhido pelo assistente de medidas.
- [x] Testar as regras novas de estoque da sacola.
- [x] Executar testes, typecheck, lint, links e build.
- [x] Commit, push e PR para `main`.

## Decisões

- A revalidação continua best-effort; falha de rede não bloqueia a compra.
- Só bloqueamos quando o catálogo afirmou indisponibilidade ou quantidade insuficiente.
- Não alteramos preços, frete, checkout nem gateways.
