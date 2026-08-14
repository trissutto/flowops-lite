# PR 1 — plano de observabilidade do funil

## 1. Auditar o contrato existente

- [x] Mapear emissores das seis etapas principais.
- [x] Mapear dados persistidos em `site_eventos`.
- [x] Verificar duplicidade, lacunas e risco de dados sensíveis.

## 2. Criar contrato seguro de diagnósticos

- [x] Definir nomes e códigos aceitos.
- [x] Sanitizar `dados` no backend antes de persistir.
- [x] Limitar profundidade, tamanho e cardinalidade.
- [x] Cobrir o sanitizador com testes unitários.

## 3. Enriquecer a agregação administrativa

- [x] Manter as seis etapas e a conversão da tela atual.
- [x] Agrupar diagnósticos por evento, código, campo e método.
- [x] Manter compatibilidade com consumidores existentes.

## 4. Instrumentar lacunas sem mudar pagamentos

- [x] Instrumentar seleção de cor/tamanho e bloqueio de sacola.
- [x] Instrumentar escolha, tentativa e falha técnica no fechamento.
- [x] Não modificar chamadas, payloads ou decisões de PagBank/Pagar.me.

## 5. Atualizar a tela administrativa

- [x] Mostrar diagnósticos abaixo do funil.
- [x] Explicar contagem por pessoas e eventos.
- [x] Manter filtros De/Até e atalhos existentes.

## 6. Validar e entregar

- [x] Testes unitários e integração existentes.
- [x] Typecheck, lint, build e links.
- [x] Revisão de segurança para PII.
- [x] Commit, push e PR para `main`.
