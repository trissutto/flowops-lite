# Plano de implementação — lançamentos em todas as lojas

## Mudança central

Generalizar a implementação já validada em `/lojas/limeira` para todas as rotas geradas por `ecommerce/src/app/(public)/lojas/[cidade]/page.tsx`.

## Passos

1. Remover a condição `s.slug === 'limeira'` da carga do catálogo, hero, vitrine e acolhimento.
2. Buscar `fetchStoreLaunches(6)` uma vez por render, sem enviar código ou slug da loja.
3. Tornar título, mensagens e avisos dependentes de `s.unit`, mantendo o catálogo idêntico entre unidades.
4. Preservar os fallbacks já implementados: hero tipográfico e link para `/novidades`.
5. Ampliar os testes puros para afirmar que a seleção não recebe nem depende de unidade.
6. Validar uma unidade da capital e uma do interior, além de Limeira, em celular e desktop.
7. Executar teste direcionado, lint, build e suíte completa; documentar somente falhas preexistentes.
8. Commitar, enviar `codex/lojas-lancamentos-todas` e entregar o link do PR para `main`.

## Arquivos esperados

- `ecommerce/src/app/(public)/lojas/[cidade]/page.tsx`
- `ecommerce/src/app/(public)/lojas/[cidade]/store-launches.test.ts`
- documentação desta ampliação

Os componentes e o serviço criados para Limeira serão reutilizados sem duplicação.
