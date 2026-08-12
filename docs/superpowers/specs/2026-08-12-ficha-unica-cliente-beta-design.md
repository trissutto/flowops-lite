# Ficha única da cliente — Beta

## Objetivo

Criar uma ficha completa da cliente, inspirada na organização visual do Shopify, que consolide dados de PDV, site, Live Commerce e Giga em uma única visão operacional por pessoa.

A entrega será paralela à ficha atual. A lista e o drawer existentes continuarão no ar até a validação da versão beta.

## Navegação e convivência com a ficha atual

- Nova rota: `/clientes-crm/beta/[id]`.
- O parâmetro `id` aceita um `Customer` visível ao usuário e resolve a identidade `Person` correspondente.
- O clique atual na cliente continua abrindo o drawer existente.
- A lista recebe uma ação explícita `Nova ficha — Beta`.
- A ficha beta possui `Voltar para clientes` e restaura busca, filtros e paginação por meio do endereço de retorno validado da própria aplicação.
- A aba selecionada é registrada na URL para permitir atualização e compartilhamento de links diretos.
- Nenhuma rota atual será removida, redirecionada ou substituída nesta fase.

## Identidade e base única

`Person` é a identidade canônica. `Customer` e os registros dos canais continuam preservados como fontes vinculadas à pessoa.

A ficha agrega:

- cadastros feitos no PDV;
- cadastros do site;
- clientes e interações da Live Commerce;
- registros importados do Giga/WinCred;
- compras de loja física, site e live;
- endereços, cashback, consentimentos e histórico vinculados;
- lojas de origem e destino;
- identificadores e cadastros vinculados à pessoa.

Vínculos determinísticos podem ser automáticos por CPF idêntico, telefone normalizado idêntico ou e-mail idêntico sem conflito. Casos contraditórios ou ambíguos permanecem separados e são encaminhados à revisão de identidade. Nenhum registro de origem é apagado. União e separação exigem auditoria.

Quando o `Customer` ainda não tiver `personId`, a ficha exibe os dados do próprio cliente como uma identidade provisória e sinaliza que a consolidação está pendente. A tela não fará fusões oportunistas durante uma leitura.

## Precedência dos dados

Quando fontes vinculadas apresentarem valores diferentes, o valor principal segue esta ordem:

1. alteração manual administrativa no FlowOps;
2. dado mais recente confirmado pela cliente;
3. PDV;
4. site;
5. live;
6. Giga legado.

Empates são resolvidos pela atualização mais recente. A resposta informa valor, origem e data sempre que esses metadados existirem. Valores divergentes não são apagados e permanecem consultáveis na procedência e auditoria.

## Estrutura visual

O topo contém:

- voltar para a lista;
- avatar e nome;
- CPF, tempo de relacionamento e loja de origem;
- marcadores de tier, RFV, manequim, situação e canais encontrados;
- ação de WhatsApp;
- identificação visível `Beta`.

O visual segue o protótipo neutro inspirado no Shopify dentro do shell atual do FlowOps. O dourado Lurd's é o acento; verde é reservado para dinheiro e resultados positivos. Nenhum dado fictício do protótipo será usado.

No celular, os cartões são empilhados e as abas usam rolagem horizontal.

## Abas

1. **Resumo** — indicadores consolidados, contato, relacionamento e atividade recente; somente leitura.
2. **Cadastro** — identificação, contato e origem; edição por seção.
3. **Perfil de moda** — manequins, corpo, estilo, cores e peças evitadas; edição por seção.
4. **Crédito** — limite, situação, trabalho, renda, referências e SPC; edição somente por administrador.
5. **Compras** — histórico paginado e consolidado de loja, site e live; somente leitura.
6. **Cashback** — saldo, indicadores e extrato; ajustes seguem as permissões já existentes.
7. **Endereços** — endereços vinculados, edição e definição do principal.
8. **LGPD** — consentimentos atuais e histórico imutável.
9. **Auditoria** — fontes, vínculos, alterações e consolidações; somente leitura.

Campos sem valor mostram `Não informado`.

## Edição

Cada aba editável possui seu próprio modo `Editar`, com `Salvar` e `Cancelar`. Não haverá um formulário único gigante.

Uma edição atualiza a informação operacional canônica e registra usuário, data, valor anterior, novo valor e origem. Réplicas necessárias ao Giga usam o outbox e nunca colocam o Giga ao vivo no caminho crítico da ficha.

A edição da aba Crédito é protegida também no backend. Ocultar controles no frontend não é considerado controle de acesso.

## Backend e carregamento

Um endpoint agregador próprio retorna cabeçalho, resumo, cadastro, perfil, crédito, cashback, endereços, consentimentos e metadados de origem. Compras extensas e auditoria são paginadas e carregadas sob demanda.

Falha numa área secundária não impede o carregamento das demais. A resposta identifica seções indisponíveis sem transformar ausência de dados em erro.

O endpoint não consulta o Giga ao vivo. Usa Postgres, espelhos e dados nativos já vinculados.

## Segurança e escopo

- A ficha usa o mesmo critério da lista: `originStoreId` ou `targetStoreId` para usuários de loja.
- Ao agregar outros `Customer` da mesma `Person`, somente registros que o ator pode acessar contribuem com dados sensíveis.
- Administradores respeitam o escopo de rede de sua função.
- Cliente inexistente retorna não encontrado.
- Cliente fora do escopo retorna acesso negado sem revelar dados.
- Acesso de escrita é revalidado a cada operação.
- Crédito só pode ser alterado por administrador.

## Concorrência e erros

- Mutações recebem a versão/data de atualização lida pela tela.
- Se o dado tiver sido alterado depois, a API recusa a gravação e solicita recarga.
- Erros de seção aparecem dentro da própria seção.
- Estados de carregamento preservam a estrutura da página.
- A URL de retorno aceita apenas caminhos internos de `/clientes-crm`, evitando redirecionamento externo.

## Validação

- Escopo de loja por `originStoreId` e `targetStoreId`.
- Cliente com múltiplos `Customer` ligados à mesma `Person`.
- Consolidação de PDV, site, live e Giga.
- Precedência de valores conflitantes.
- Identidade provisória sem `personId`.
- Permissão administrativa para editar Crédito.
- Paginação de compras e auditoria.
- Preservação da lista ao voltar.
- Links diretos para aba específica.
- Responsividade em computador e celular.
- Drawer e rotas antigas sem regressão.
- TypeScript, lint disponível, testes focados e build em proporção ao risco.

## Fora do escopo desta entrega

- Substituir ou apagar o drawer atual.
- Tornar a rota beta a ficha padrão.
- Redesenhar o menu geral do FlowOps.
- Fazer fusões ambíguas automaticamente.
- Consultar ou escrever no Giga de forma síncrona.
- Inventar dados que ainda não existam no banco.
