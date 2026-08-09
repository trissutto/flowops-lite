# Plano de implementação — Gestão de Obra por Imóvel

**Referência:** `docs/superpowers/specs/2026-08-08-gestao-obras-imoveis-design.md`

## Bloco 1 — Persistência e cálculos financeiros

1. Alterar `backend/prisma/schema.prisma` para relacionar `Property` às obras e adicionar os modelos de projeto, etapa, categoria, fornecedor, contratação, pagamento, entrada, estorno, documento e auditoria.
2. Usar `Int` em centavos em todos os valores financeiros, relações opcionais para etapa/fornecedor/categoria e cancelamento lógico nos registros financeiros.
3. Criar `backend/src/properties/properties-construction.calculations.ts` com funções puras para:
   - previsto, contratado, pago líquido, entradas, saldo, a pagar e disponível;
   - validação de pagamento excedente e estorno;
   - composição cronológica da conta corrente e saldo acumulado;
   - identificação de parcelas e etapas atrasadas.
4. Criar `backend/src/properties/properties-construction.calculations.spec.ts` cobrindo pagamentos parciais, excesso autorizado, estornos parciais/totais, cancelamentos e saldo acumulado.
5. Gerar o Prisma Client e validar o schema antes de avançar para os serviços.

## Bloco 2 — Serviço e API de Gestão de Obra

1. Criar `backend/src/properties/properties-construction.service.ts` para:
   - validar a relação imóvel → obra em todas as operações;
   - criar/listar/editar/encerrar obras;
   - criar/editar/reordenar etapas e atualizar progresso;
   - manter categorias globais e garantir as categorias iniciais;
   - criar/editar/inativar fornecedores exclusivos de obra;
   - criar/cancelar contratações;
   - criar pagamentos parciais, validar excesso e registrar estornos;
   - criar/cancelar entradas;
   - retornar resumo, cronograma e conta corrente filtrada;
   - registrar auditoria com usuário, entidade e mudança.
2. Criar `backend/src/properties/properties-construction-storage.service.ts` usando o R2 dos imóveis, com allowlist PDF/JPG/PNG, limite de 10 MB, chave privada e download autenticado.
3. Criar `backend/src/properties/properties-construction.controller.ts` sob `/properties/:propertyId/construction`, sempre com `JwtAuthGuard` e a mesma trava SUPREMO do módulo imobiliário.
4. Adicionar rotas para projetos, resumo, etapas, contratações, pagamentos, estornos, entradas, conta corrente, fornecedores e documentos.
5. Registrar controller e serviços em `backend/src/properties/properties.module.ts`.
6. Garantir que nenhuma nova entidade seja incluída no contrato ou no publicador da ficha para corretores.

## Bloco 3 — Nova aba no frontend

1. Criar `frontend/src/components/imobiliario/PropertyConstructionTab.tsx` com tipos locais, carregamento, tratamento de erro e atualização após mutações.
2. Criar o seletor de obra e os fluxos de criar, editar, pausar e encerrar uma obra.
3. Implementar as subáreas:
   - **Visão geral:** cartões de previsto, contratado, pago, entradas, saldo, a pagar e disponível, mais alertas de atraso;
   - **Conta corrente:** tabela/cartões responsivos, filtros De/Até e atalhos Hoje/Ontem/7 dias/Mês, formulário de contratação, pagamento e entrada;
   - **Cronograma:** lista ordenada de etapas, datas, responsável, orçamento, progresso, status e desvios;
   - **Fornecedores/Prestadores:** cadastro global separado das lojas, busca e ativação/inativação.
4. Permitir anexar vários recibos/documentos a um pagamento e baixar o arquivo por rota autenticada.
5. Exibir confirmações antes de cancelar/estornar/encerrar e estados vazios com próxima ação clara.
6. Alterar `frontend/src/app/imobiliario/[id]/page.tsx` para incluir o ícone, a aba **Gestão de Obra** e renderizar o novo componente sem misturá-lo à ficha comercial.

## Bloco 4 — Verificação funcional e regressão

1. Rodar os testes unitários novos e os testes existentes do backend.
2. Rodar `prisma validate`, `prisma generate` e o build do backend.
3. Rodar lint e build do frontend.
4. Revisar o diff procurando:
   - uso acidental de `Float`/reais em valores financeiros;
   - rotas sem SUPREMO;
   - consulta que aceite uma obra de outro imóvel;
   - URL pública ou credencial de R2 no retorno;
   - importação de Gestão de Obra no portal público;
   - exclusão física de registros financeiros.
5. Fazer teste manual local com mock ou chamadas isoladas cobrindo: duas obras no mesmo imóvel, contratação com três pagamentos, aporte, estorno, etapa atrasada e anexo.

## Bloco 5 — Entrega segura

1. Atualizar a documentação com qualquer decisão técnica descoberta durante a implementação.
2. Commitar as mudanças na branch `codex/feat-gestao-obras-imoveis`.
3. Enviar a branch ao GitHub e fornecer o link da PR para `main`.
4. Orientar implantação backend primeiro, fora do horário de loja, seguida do frontend após o Railway ficar saudável.
