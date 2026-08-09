# PDV — modo noturno por computador

## Objetivo

Permitir que cada computador de caixa escolha entre o tema claro atual e um tema noturno confortável, sem alterar o PDV dos demais computadores e sem mudar nenhuma regra de venda.

## Escopo

A mudança se limita à tela `frontend/src/app/minha-loja/pdv/page.tsx` e aos estilos visuais usados por ela. Não haverá alteração de backend, banco, API, autenticação, estoque, pagamento, impressão, NFC-e ou integração com o Giga.

O modo noturno deve funcionar nos dois layouts disponíveis no PDV:

- visual destacado, com pagamentos rápidos;
- visual anterior, acessível pelo botão de retorno em um clique.

## Preferência local

- O cabeçalho terá um botão com lua/sol e os textos `Modo noturno` e `Modo claro`.
- A escolha será salva em `localStorage`, na chave `lurds_pdv_color_theme`.
- Os valores válidos serão `light` e `dark`.
- A preferência será exclusiva daquele navegador/computador.
- O tema claro continuará sendo o padrão quando não houver preferência salva ou quando o armazenamento local estiver indisponível.
- A troca será imediata, sem recarregar a página e sem modificar a venda aberta.

## Arquitetura visual

O componente raiz do PDV receberá uma classe de tema. Os estilos noturnos ficarão subordinados a essa classe, impedindo que a mudança alcance outras páginas do sistema.

Os estilos serão centralizados e aplicarão uma paleta coerente aos utilitários já usados na tela. Não será usado filtro de inversão, pois ele distorceria fotos, logos e cores operacionais.

### Paleta

- Fundo principal: azul-marinho muito escuro (`#0B1120`).
- Cabeçalho, menu e painéis principais: grafite azulado (`#111827` e `#172033`).
- Campos e superfícies elevadas: `#1E293B`.
- Bordas: `#334155`.
- Texto principal: `#F8FAFC`.
- Texto secundário: `#CBD5E1`.
- Texto discreto: `#94A3B8`.
- Hover neutro: `#263449`.
- Dourado continuará indicando seleção, campanha e destaque de marca.
- Verde continuará reservado a valores, dinheiro e finalização. Em textos sobre fundo escuro será usada uma variação com contraste suficiente; botões de finalização manterão o verde operacional atual.

### Elementos abrangidos

O tema será aplicado a:

- fundo geral e cabeçalho;
- menu lateral completo;
- barra de bipagem e campos;
- carrinho e linhas de produtos;
- identificação da cliente;
- resumo, subtotal, descontos e total;
- barra de pagamentos rápidos;
- botões de campanhas e descontos;
- vendas pausadas e alertas;
- todos os modais abertos dentro do PDV, incluindo cliente, vendedora, pagamento, desconto, vale-troca e vale-presente;
- rodapé e indicadores de conexão.

Estados de erro, alerta e sucesso manterão seu significado, com fundos escuros suavemente coloridos e contraste legível.

### Imagens e bandeiras

- Fotos de produtos não receberão filtros.
- Logos das bandeiras manterão a proporção natural.
- Os cartões das bandeiras permanecerão brancos no modo noturno para preservar a leitura original dos logos.
- Nenhuma imagem será invertida, recolorida ou esticada.

## Segurança funcional

- O alternador controlará somente a classe visual do PDV.
- Nenhum handler existente será substituído ou duplicado.
- Todos os botões, atalhos, campanhas, descontos, escolha de cliente, escolha de vendedora, vendas pausadas e formas de pagamento continuarão ativos.
- O modo treinamento continuará obedecendo às proteções atuais.
- Alternar o tema durante uma venda não poderá alterar itens, pagamentos, valores ou estado do carrinho.

## Responsividade

- O botão de tema ficará visível no cabeçalho do desktop.
- Em telas menores, o botão permanecerá visível como ícone de lua/sol; o texto ficará oculto para não remover nem comprimir os controles atuais.
- A mudança de tema não alterará dimensões, quantidade de peças visíveis, rolagem do carrinho ou distribuição dos pagamentos.

## Tratamento de falhas

- Falha ao ler ou gravar `localStorage` não bloqueará o PDV.
- Nessa situação, o tema claro será usado e a venda continuará normalmente.
- Valores desconhecidos na chave local serão ignorados.

## Validação

- Build de produção, lint e verificação de tipos do frontend.
- Conferência dos temas claro e noturno no visual destacado.
- Conferência dos temas claro e noturno no visual anterior.
- Persistência após atualizar a página no mesmo computador.
- Confirmação de que outro computador sem a chave continua no tema claro.
- Conferência visual do carrinho, resumo, pagamentos, menu e principais modais.
- Conferência de contraste, foco, hover, estados desabilitados, erros e sucessos.
- Confirmação de que fotos e bandeiras não sofrem distorção ou inversão.
- Teste de troca de tema com venda aberta, sem mudança nos dados da venda.

## Fora de escopo

- Tema noturno nas demais páginas de `Minha Loja`.
- Sincronização do tema entre computadores.
- Configuração no backend ou no cadastro da loja.
- Ativação automática por horário ou pelo tema do Windows.
- Deploy automático.
