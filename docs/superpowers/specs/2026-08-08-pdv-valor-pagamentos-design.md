# PDV — destaque de valor e pagamentos

## Objetivo

Dar prioridade visual ao valor que falta cobrar e reduzir os cliques para escolher a forma de pagamento, sem alterar nenhuma regra de venda, estoque, PIX, crediário, NFC-e ou integração com o Giga.

## Escopo

A mudança é somente no frontend do PDV em `frontend/src/app/minha-loja/pdv/page.tsx`. O backend, os endpoints e os formatos enviados pela tela permanecem inalterados.

## Layout novo

O layout novo será o padrão, mantendo o menu lateral esquerdo existente e o painel direito com cliente, subtotal, desconto, pagamentos parciais e o total em verde.

### Carrinho

- Linhas compactas, com miniatura de 44 px e altura suficiente para mostrar de seis a oito peças em uma tela de caixa comum.
- A lista terá rolagem própria quando exceder a área disponível.
- O último item bipado continuará aparecendo no topo e recebendo o destaque visual já existente.
- Quantidade, preço, desconto e remoção continuarão funcionando exatamente como hoje.

### Pagamento rápido

Uma barra compacta ficará abaixo do conjunto carrinho + resumo, sem repetir o total e sem botão `Finalizar F8`.

- Crédito: Mastercard, Visa/Visanet, Cielo, Hipercard e Amex.
- Débito: RedeShop, Visa Electron e Elo.
- Outras formas: PIX, Dinheiro, Crediário, Vale-troca, Venda Online, Vale Presente e Marcar.
- Convênio aparecerá somente quando estiver ativo para a loja.
- Os logotipos usarão proporção natural (`object-contain`), sem deformação.
- Clicar numa bandeira abrirá o modal com crédito/débito e a bandeira já selecionados.
- Clicar nas demais formas reutilizará os fluxos atuais, inclusive validações de CPF, PIX, crediário e marcado.

### Modal de pagamento

- O valor restante será o elemento mais forte no topo.
- O método e a bandeira escolhidos permanecerão claramente identificados.
- Crédito continuará oferecendo de 1× até 12× sem juros, conforme as regras atuais.
- O botão verde de finalização ficará somente no rodapé fixo do modal e mostrará o valor que será cobrado.
- Pagamentos mistos, troco, vale-troca, PIX e venda online continuarão usando os estados e endpoints atuais.

## Retorno em um clique

O código do layout atual permanecerá no mesmo arquivo e continuará funcional.

- Um botão discreto no cabeçalho alternará entre `Novo visual` e `Visual anterior`.
- A escolha será salva no `localStorage` do computador do caixa.
- A troca será imediata e não recarregará, cancelará ou modificará a venda aberta.
- Cada computador poderá voltar ao visual anterior independentemente dos demais.
- A chave local será `lurds_pdv_checkout_layout`, com valores `highlighted` e `legacy`.

## Segurança operacional

- Nenhuma chamada de API será removida ou substituída.
- Nenhuma lógica de finalização, pagamento, impressão, estoque ou treinamento será duplicada.
- Os novos botões chamarão os mesmos handlers já usados pelo painel atual.
- O modo treinamento continuará obedecendo às proteções existentes.
- O layout anterior servirá como fallback instantâneo durante o piloto.

## Responsividade

- Desktop: menu lateral, carrinho, resumo e barra rápida completa.
- Telas menores: a barra poderá quebrar em duas linhas, sem distorcer logos ou ocultar formas.
- Mobile: o comportamento atual será preservado; a nova barra não substituirá os atalhos móveis existentes.

## Validação

- TypeScript/build do frontend.
- Verificação direcionada de lint no arquivo alterado.
- Teste visual nas larguras 1366×768, 1440×900 e 1920×1080.
- Teste do alternador de layout e persistência após atualizar a página.
- Teste de abertura de cada forma de pagamento, sem concluir uma venda real.
- Conferência de sete ou mais itens no carrinho e rolagem interna.
- Conferência de pagamento misto e de valor restante no modal.

## Fora de escopo

- Alterações no backend, banco ou Railway.
- Mudanças nas regras de parcelamento ou gateways.
- Deploy automático.
- Remoção definitiva do layout anterior durante o piloto.
