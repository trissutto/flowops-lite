# Plano de implementação — lançamentos em todas as lojas

## Resultado esperado

As 14 páginas `/lojas/[cidade]` usam a experiência já criada para Limeira:
hero de novidades, vitrine de até seis peças, CTA de WhatsApp local e bloco de
acolhimento. Nenhuma unidade promete estoque sem confirmação.

## 1. Generalizar a página local

**Arquivo:**

- `ecommerce/src/app/(public)/lojas/[cidade]/page.tsx`

**Trabalho:**

- Remover `isLimeira` e todas as condições ligadas ao slug `limeira`.
- Buscar `fetchStoreLaunches(6)` para qualquer unidade válida.
- Usar a primeira imagem elegível como fundo do hero em todas as páginas.
- Gerar título e descrição do hero com `s.unit`.
- Renderizar `StoreHeroActions`, `StoreLaunches` e o bloco de acolhimento para
  todas as unidades.
- Preservar metadata, JSON-LD, breadcrumbs, endereço, horários, mapa e lista de
  outras lojas.

## 2. Fortalecer contratos puros

**Arquivos:**

- `ecommerce/src/app/(public)/lojas/[cidade]/store-launches.ts`
- `ecommerce/src/app/(public)/lojas/[cidade]/store-launches.test.ts`

**Trabalho:**

- Centralizar textos dinâmicos do hero em helper puro quando isso facilitar
  testes sem renderização React.
- Testar títulos para todas as 14 unidades.
- Confirmar que não há referência exclusiva a Limeira nos helpers.
- Manter o link de produto com `?cor=` quando existir `vitrineCor`.

## 3. Serviço e fallback

**Arquivos:**

- `ecommerce/src/services/store-launches.server.ts`
- testes associados, se necessários

**Trabalho:**

- Reutilizar o serviço atual sem criar 14 consultas na mesma página.
- Continuar limitando a seis cards com imagem e disponibilidade.
- Continuar retornando lista vazia em falha do catálogo.
- Não adicionar consulta ao estoque físico por unidade.

## 4. Eventos e WhatsApp

**Arquivos:**

- `ecommerce/src/app/(public)/lojas/[cidade]/StoreLaunches.tsx`
- `ecommerce/src/app/(public)/lojas/[cidade]/StoreCtas.tsx`

**Trabalho:**

- Garantir que eventos recebam `store.unit` em todas as páginas.
- Garantir que o WhatsApp venha do objeto da loja.
- Manter mensagens de consulta, nunca de disponibilidade confirmada.
- Não criar uma taxonomia nova de tracking.

## 5. Testes e validação

**Comandos:**

- `npm test -- --run`
- `npm run links:check`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`

**Conferência visual:**

- Abrir pelo menos uma unidade de São Paulo e uma do interior.
- Testar celular 375×812 e desktop 1440×900.
- Confirmar legibilidade do hero, âncora de lançamentos, WhatsApp correto,
  ausência de overflow e fallback sem imagem.

## 6. Revisão e entrega

- Revisar o diff contra `origin/main`, garantindo que o PR contenha a base de
  Limeira e a generalização, sem mudanças do worktree principal.
- Rodar CodeRabbit se o WSL tiver os pré-requisitos; caso contrário, registrar
  a limitação e fazer revisão manual.
- Commitar na branch `codex/lojas-lancamentos-todas-cidades`.
- Enviar a branch e fornecer o link de abertura do PR contra `main`.
- Não executar deploy.
