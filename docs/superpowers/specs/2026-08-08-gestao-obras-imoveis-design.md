# Gestão de Obra por Imóvel — Especificação de Design

**Data:** 08/08/2026

**Status:** desenho funcional aprovado; aguardando revisão da especificação escrita

**Escopo:** módulo interno de imóveis do FlowOps Lite

## 1. Contexto

Cada imóvel precisa concentrar o controle das obras realizadas ao longo do tempo. Hoje a ficha do imóvel mantém dados cadastrais, documentos e a ficha comercial, mas não registra orçamento, contratações, pagamentos, recibos, fornecedores de obra ou andamento físico.

A solução adicionará uma área interna de **Gestão de Obra** à ficha de cada imóvel. Ela será independente dos fornecedores das lojas e não enviará nenhum dado ao portal público dos corretores.

## 2. Objetivos

- Manter várias obras no histórico do mesmo imóvel, inclusive obras simultâneas quando necessário.
- Comparar os valores **previsto**, **contratado** e **pago**.
- Registrar contratações com um ou vários pagamentos parciais.
- Registrar entradas financeiras, incluindo aportes, reembolsos e estornos.
- Anexar comprovantes, recibos, notas e outros documentos a cada pagamento.
- Controlar o cronograma por etapas simples, com responsáveis, datas e progresso.
- Manter um cadastro global de fornecedores e prestadores de obra, separado dos fornecedores das lojas.
- Preservar histórico, rastreabilidade e segurança dos dados.

## 3. Fora do escopo inicial

- Gantt completo com dependências automáticas entre tarefas.
- Compras e estoque de materiais de construção.
- Aprovação multinível de pagamentos.
- Integração contábil ou bancária automática.
- Exposição de dados financeiros na ficha pública do imóvel.
- Aplicativo específico para o fornecedor ou prestador.

Esses itens poderão ser adicionados depois sem alterar o núcleo proposto.

## 4. Acesso e navegação

A ficha interna do imóvel ganhará a aba **Gestão de Obra**. O acesso continuará restrito ao perfil `SUPREMO`, seguindo a proteção já utilizada pelo módulo imobiliário.

Dentro da aba haverá:

1. **Visão geral** — indicadores financeiros e andamento da obra selecionada.
2. **Conta corrente** — movimentações, pagamentos e anexos.
3. **Cronograma** — etapas e progresso físico.
4. **Fornecedores/Prestadores** — consulta e manutenção do cadastro próprio de obras.

O cabeçalho permitirá selecionar uma obra existente, criar uma nova e encerrar a obra selecionada. Exemplos: “Construção 2026” e “Reforma 2029”. Uma obra encerrada permanecerá disponível para consulta.

## 5. Visão geral

A visão geral exibirá, em reais:

- **Previsto:** soma do orçamento planejado das etapas/categorias.
- **Contratado:** soma das contratações ativas.
- **Pago:** soma dos pagamentos efetivados, descontados os estornos.
- **Entradas:** aportes e reembolsos recebidos.
- **Saldo financeiro:** entradas menos pagamentos líquidos.
- **A pagar:** contratado menos pago vinculado às contratações.
- **Disponível no orçamento:** previsto menos contratado.
- **Progresso físico:** média ponderada das etapas ou média simples quando não houver peso/orçamento.

Também mostrará quantidade de pagamentos vencidos, etapas atrasadas e documentos ausentes.

Todos os valores monetários serão armazenados em centavos inteiros. Cálculos serão realizados no backend; o frontend apenas exibirá os totais retornados.

## 6. Orçamento, contratação e pagamentos

### 6.1 Orçamento previsto

Cada etapa poderá ter um valor previsto e uma categoria. Haverá categorias iniciais, como projeto, documentação, demolição, fundação, alvenaria, cobertura, elétrica, hidráulica, acabamentos, mão de obra, materiais e outros. O usuário poderá cadastrar categorias adicionais.

### 6.2 Contratação

Uma contratação representará um serviço, material ou compromisso financeiro. Campos principais:

- descrição;
- fornecedor/prestador opcional;
- etapa e categoria opcionais;
- data de contratação;
- valor contratado;
- vencimento previsto;
- observações;
- status: ativa, concluída ou cancelada.

Cancelar não apagará os pagamentos existentes nem removerá o histórico. Exclusões materiais serão evitadas; registros serão cancelados ou arquivados.

### 6.3 Pagamentos parciais

Uma contratação poderá ter vários pagamentos. Cada pagamento terá:

- data;
- valor;
- fornecedor/prestador herdado ou informado;
- forma de pagamento opcional;
- descrição/observação;
- contratação e etapa vinculadas;
- um ou vários anexos;
- status ativo ou estornado.

O sistema calculará automaticamente o total pago e o saldo restante da contratação. Pagamentos acima do saldo exigirão confirmação explícita e ficarão sinalizados.

### 6.4 Entradas e estornos

A conta corrente aceitará:

- aporte;
- reembolso;
- outra entrada;
- estorno total ou parcial de pagamento.

Um estorno ficará vinculado ao pagamento original. Nenhuma movimentação conciliada será apagada fisicamente.

## 7. Conta corrente

A conta corrente será uma linha do tempo financeira unificada. Cada linha indicará data, tipo, descrição, fornecedor/prestador, etapa, entrada, saída, saldo acumulado e disponibilidade de anexos.

Filtros obrigatórios:

- campos **De** e **Até** (`type=date`);
- atalhos Hoje, Ontem, 7 dias e Mês;
- tipo de movimentação;
- fornecedor/prestador;
- etapa;
- situação do comprovante.

A ordenação padrão será da data mais recente para a mais antiga. O saldo acumulado será calculado cronologicamente e não dependerá da ordenação visual.

## 8. Cronograma simples

O cronograma será organizado por etapas, sem dependências automáticas de Gantt. Cada etapa terá:

- nome e descrição;
- responsável;
- início e término previstos;
- início e término realizados;
- orçamento previsto;
- percentual concluído de 0 a 100;
- status: não iniciada, em andamento, pausada, concluída ou cancelada;
- ordem de exibição;
- contratações e pagamentos vinculados.

O sistema sinalizará etapa atrasada quando a data final prevista tiver passado, o percentual for inferior a 100 e o status não for concluído ou cancelado.

A etapa mostrará previsto, contratado, pago e desvio orçamentário. Alterações de percentual e status entrarão no histórico de auditoria.

## 9. Fornecedores e prestadores de obra

Será criado um cadastro global exclusivo para obras, reutilizável entre imóveis, sem vínculo com as tabelas de fornecedores das lojas.

Campos principais:

- nome/razão social;
- nome fantasia;
- tipo: fornecedor, prestador ou ambos;
- especialidade/serviço;
- CPF/CNPJ;
- telefone e e-mail;
- chave PIX e observações de pagamento;
- observações internas;
- situação ativa/inativa.

CPF/CNPJ, quando informado, será normalizado e impedirá duplicidade. Fornecedores inativos permanecerão visíveis no histórico, mas não aparecerão como opção padrão em novos lançamentos.

## 10. Documentos e recibos

Cada pagamento poderá receber vários documentos, como recibo, nota fiscal, comprovante, orçamento ou contrato.

- Formatos iniciais: PDF, JPG e PNG.
- Limite inicial: 10 MB por arquivo, igual ao padrão atual do módulo de imóveis.
- Armazenamento privado no bucket R2 já configurado para imóveis.
- Download sempre mediado pelo backend/autorização ou por URL assinada de curta duração.
- Metadados: nome original, tipo MIME, tamanho, chave do objeto, autor e data do envio.
- Remoção lógica/auditada; o arquivo físico só será eliminado por processo seguro posterior.

Nenhum endereço interno dos arquivos será incluído na publicação destinada aos corretores.

## 11. Modelo de dados proposto

Novas entidades Prisma, com nomes finais ajustáveis na implementação:

- `PropertyConstructionProject` — obra vinculada ao imóvel.
- `ConstructionCategory` — categorias padrão e personalizadas.
- `ConstructionVendor` — fornecedores/prestadores exclusivos de obra.
- `ConstructionStage` — etapas do cronograma.
- `ConstructionCommitment` — contratação ou compromisso financeiro.
- `ConstructionPayment` — pagamento parcial ou integral.
- `ConstructionEntry` — aporte, reembolso ou outra entrada.
- `ConstructionPaymentReversal` — estorno vinculado ao pagamento.
- `ConstructionDocument` — metadados de anexos.
- `ConstructionAuditLog` — eventos de auditoria específicos da gestão de obra.

Todas as entidades financeiras terão timestamps, autor da criação/alteração e campos de cancelamento/arquivamento quando aplicável. Relações terão índices por obra, imóvel, data, fornecedor, etapa e status.

## 12. API proposta

O backend NestJS terá rotas sob `/properties/:propertyId/construction` e um conjunto separado para fornecedores de obra.

Operações principais:

- listar, criar, editar e encerrar obras;
- obter o resumo consolidado da obra;
- manter categorias, etapas e progresso;
- criar/cancelar contratações;
- criar/estornar pagamentos;
- criar entradas;
- listar a conta corrente com filtros De/Até;
- enviar, baixar e remover logicamente documentos;
- listar e manter fornecedores/prestadores;
- consultar o histórico de auditoria.

Cada operação validará no backend se a obra pertence ao imóvel informado. Alterações financeiras críticas usarão transações Prisma para impedir totais parciais ou documentos sem lançamento correspondente.

## 13. Interface e estados

A interface seguirá o tema escuro já usado na ficha do imóvel e seus componentes atuais.

- Formulários financeiros exibirão moeda brasileira e enviarão centavos inteiros.
- Criação/edição será feita por modal ou painel lateral, sem abandonar o contexto do imóvel.
- A conta corrente será utilizável em telas menores com cartões responsivos.
- Botões destrutivos serão substituídos por cancelar, estornar ou arquivar, com confirmação.
- Estados vazios explicarão a próxima ação: criar obra, etapa, contratação ou pagamento.
- Erros de upload manterão o lançamento salvo e permitirão tentar o anexo novamente.
- Totais serão atualizados após cada mutação bem-sucedida.

## 14. Segurança e auditoria

- Todas as rotas exigirão autenticação e papel `SUPREMO`.
- O portal público não terá importação, consulta ou rota para dados de obra.
- Cada criação, alteração, cancelamento, estorno e remoção de documento registrará usuário, data e resumo da mudança.
- Valores anteriores e novos serão preservados nos eventos financeiros relevantes.
- URLs de armazenamento e credenciais nunca serão expostas no frontend.
- Dados de CPF/CNPJ e PIX não aparecerão em logs de erro em texto aberto.

## 15. Migração e implantação

A mudança será aditiva: novas tabelas e relações opcionais, sem alterar o comportamento das fichas existentes. Nenhuma obra será criada automaticamente para os imóveis atuais.

O backend aplicará o schema pelo fluxo atual de `prisma db push` no Railway. Como o reinício dura aproximadamente 30 segundos, o deploy deverá ocorrer fora do horário de loja aberta. O frontend poderá ser publicado depois que o backend estiver saudável.

## 16. Critérios de aceite

1. Um usuário SUPREMO cria duas obras diferentes no mesmo imóvel e consulta ambas separadamente.
2. Uma obra exibe corretamente previsto, contratado, pago, entradas, saldo, a pagar e disponível.
3. Uma contratação de R$ 12.000 aceita, por exemplo, três pagamentos e mostra o saldo restante correto.
4. Cada pagamento aceita vários anexos privados e permite download autorizado.
5. Aporte, reembolso e estorno alteram corretamente a conta corrente e o saldo.
6. Etapas mostram datas, responsável, progresso, valores vinculados e indicação de atraso.
7. O mesmo fornecedor de obra pode ser usado em imóveis diferentes sem aparecer nos fornecedores das lojas.
8. Registros cancelados permanecem no histórico e não distorcem os totais ativos.
9. Filtros De/Até e atalhos Hoje/Ontem/7 dias/Mês funcionam na conta corrente.
10. Nenhuma informação da Gestão de Obra aparece no portal público dos corretores.
11. Usuários sem papel SUPREMO recebem acesso negado no frontend e no backend.
12. Testes de cálculo cobrem pagamentos parciais, excesso de pagamento, estornos parciais e totais.

## 17. Decisões aprovadas

- Implementar a abordagem intermediária de Gestão de Obra integrada.
- Controlar previsto, contratado e pago.
- Permitir vários pagamentos por contratação.
- Permitir várias obras ao longo do tempo no mesmo imóvel.
- Registrar entradas, reembolsos e estornos.
- Usar cronograma simples por etapas, sem Gantt com dependências.
- Usar cadastro global de fornecedores/prestadores de obra separado das lojas.
- Manter todo o módulo privado e restrito ao perfil SUPREMO.
