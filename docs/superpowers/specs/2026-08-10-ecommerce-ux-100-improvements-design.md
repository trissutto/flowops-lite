# Lurd's Ecommerce — melhoria visual, fluidez e usabilidade

## Objetivo

Executar as 100 melhorias levantadas na auditoria do site público sem interromper a operação, priorizando confiança, conversão mobile, consistência do catálogo, acessibilidade e desempenho percebido.

## Estratégia aprovada

O trabalho será entregue em ondas na branch `feat/ecommerce-ux-100-improvements`. Cada onda deve manter build, lint e testes verdes. Banco, Railway, domínio de produção e branch `main` não serão alterados durante a implementação. Push, PR e deploy serão tratados apenas depois da validação local.

## Escopo por onda

### Onda 1 — vinte correções críticas

- Tornar o consentimento de cookies compacto e não bloqueante no mobile.
- Corrigir a comunicação incompleta de frete grátis.
- Unificar a política de troca exibida nas páginas.
- Unificar a comunicação da faixa de tamanhos.
- Garantir um H1 textual e acessível na home.
- Melhorar legibilidade, enquadramento responsivo e hierarquia dos CTAs do hero.
- Corrigir textos de categorias sem acentos.
- Tratar divergências visíveis entre nome, cor e disponibilidade nos componentes de catálogo.
- Exibir disponibilidade de tamanhos com estados claros.
- Exigir tamanho antes de adicionar o produto à sacola.
- Criar ação de compra persistente no mobile.

### Onda 2 — home e identidade

- Compactar cabeçalho e barra promocional.
- Dar maior destaque à busca e à compra por tamanho/ocasião.
- Simplificar blocos institucionais e categorias.
- Melhorar carrosséis, prova social, selos e benefícios de retirada/troca.
- Evitar repetição desnecessária de produtos nas vitrines.

### Onda 3 — catálogo e filtros

- Melhorar persistência, feedback e remoção de filtros.
- Preservar posição, ordenação e visualização ao navegar entre catálogo e produto.
- Expandir filtros úteis sem introduzir controles sem suporte nos dados reais.
- Melhorar cards, fotos secundárias, cores, tamanhos, preços e estados de carregamento.
- Substituir linguagem corporal negativa por descrições objetivas de modelagem.

### Onda 4 — produto e conversão

- Melhorar galeria, zoom, informações de modelo, medidas e caimento.
- Tornar descrições escaneáveis e tecnicamente consistentes.
- Melhorar recomendação de tamanho e transparência de dados.
- Reforçar frete, retirada, avaliações e recomendações sem deslocamento de layout.
- Consolidar a hierarquia entre consultora virtual, WhatsApp e tirar dúvida.

## Arquitetura e limites

- Reutilizar componentes, tokens e padrões existentes em `ecommerce/src`.
- Não criar uma segunda biblioteca visual paralela.
- Separar correções de conteúdo estático de inconsistências originadas no banco. O frontend deve apresentar estados honestos, mas não inventar atributos ausentes.
- Mudanças que exijam migração, alteração de dados ou configuração do Railway ficam fora desta branch e serão registradas como pendência.
- Não modificar os fluxos de PDV, estoque, pagamento, ERP ou sincronização descritos em `AGENTS.md`.
- Manter compatibilidade com Next.js 15 e React 19 já usados pelo ecommerce.

## Dados e estados

- Informações de frete, troca e faixa de tamanhos devem ter uma fonte única no frontend quando forem institucionais.
- Seleção de tamanho deve ser explícita e validada antes da inclusão na sacola.
- Produtos com dados inconsistentes devem usar fallbacks neutros, sem contradizer nome, cor, imagem ou estoque.
- Filtros e preferências de grade podem ser persistidos no navegador; dados pessoais não serão adicionados a essa persistência.

## Acessibilidade

- Preservar link de salto, landmarks e nomes acessíveis já existentes.
- Garantir hierarquia de títulos, foco visível, navegação por teclado, alvos de toque adequados e contraste AA.
- Diálogos devem controlar foco, ter rótulo e permitir encerramento claro.
- Movimentos novos devem respeitar `prefers-reduced-motion`.

## Desempenho e fluidez

- Evitar novas dependências sem necessidade comprovada.
- Reservar espaço para conteúdo assíncrono e imagens para reduzir deslocamento de layout.
- Aplicar carregamento preguiçoso fora da primeira dobra e manter o hero prioritário.
- Evitar renderização de listas/carrosséis duplicados quando os mesmos produtos já estiverem presentes.

## Tratamento de erros

- Busca, filtros, frete, recomendações e sacola devem exibir falha recuperável e ação de tentar novamente.
- Indisponibilidade de APIs não deve apagar conteúdo já carregado.
- Nenhum erro pode deixar a interface presa indefinidamente em “Carregando”.

## Verificação

- Executar `npm ci`, lint, testes e build dentro de `ecommerce`.
- Adicionar ou atualizar testes para componentes e regras alterados.
- Validar home, categoria, produto, busca, menu e sacola em desktop e viewport mobile.
- Comparar visualmente com o site atual e verificar ausência de regressões de teclado e foco.
- Revisar o diff antes de qualquer commit de implementação.

## Critérios de conclusão

- Os 100 itens da auditoria ficam implementados ou classificados como dependência de conteúdo/dados, com justificativa verificável.
- Os vinte itens críticos ficam implementados e testados.
- Lint, testes e build passam.
- Nenhuma alteração é aplicada diretamente ao Railway, Vercel ou `main`.
- A entrega final informa mudanças, testes, pendências e instruções seguras para PR/deploy.
