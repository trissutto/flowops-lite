# PR 3 — checkout e mobile

- [x] Auditar identificação, endereço, frete, pagamento e revisão.
- [x] Confirmar checkout convidado e autocomplete móvel.
- [x] Preservar progresso da aba após atualização acidental.
- [x] Nunca persistir token ou dados do cartão.
- [x] Limpar o rascunho após pedido criado.
- [x] Registrar etapa/campo de validação sem registrar valor ou PII.
- [x] Melhorar ações de teclado móvel.
- [x] Testar restauração, descarte e privacidade do rascunho.
- [x] Validar em navegador a retomada e viewport de 390 px sem overflow.
- [x] Executar testes, typecheck, lint, links e build.
- [x] Commit, push e PR para `main`.

## Limites

- Nenhuma chamada, credencial, payload ou regra de PagBank/Pagar.me será alterada.
- O rascunho usa `sessionStorage`: fica apenas na aba e some ao encerrá-la.
- Cartão nunca é retomado como etapa concluída, pois o token não será armazenado.
