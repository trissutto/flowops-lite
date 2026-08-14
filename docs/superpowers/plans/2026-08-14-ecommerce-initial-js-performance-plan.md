# Ecommerce — plano de redução do JavaScript inicial

## Objetivo

Implementar a especificação `docs/superpowers/specs/2026-08-14-ecommerce-initial-js-performance-design.md` sem alterar pagamento, catálogo ou dados operacionais.

## Etapa 1 — linha de base

- Executar testes, typecheck, lint e build de produção no diretório `ecommerce`.
- Registrar tamanhos e chunks reportados pelo build.
- Mapear imports de Framer Motion e componentes-client presentes nos layouts globais.
- Preservar falhas preexistentes separadamente das regressões desta mudança.

## Etapa 2 — widgets públicos sob demanda

- Criar uma fronteira-client pequena para widgets opcionais do layout público.
- Manter um launcher leve e acessível da consultora no HTML inicial.
- Importar o painel completo da consultora somente quando a cliente o abrir ou quando um convite contextual solicitar sua abertura.
- Importar o cupom apenas após a combinação já existente de tempo e intenção de rolagem.
- Preservar bloqueio por rota, persistência no `localStorage`, tecla Escape e regras de reaparecimento.
- Adicionar testes das condições de carregamento e das rotas proibidas.

## Etapa 3 — assistente de tamanho sob demanda

- Separar o disparador leve da implementação completa do Fit Assistant.
- Importar o fluxo de recomendação somente após o clique da cliente.
- Preservar seleção de tamanho, cálculo, erros, foco e acesso ao WhatsApp.
- Garantir que falha de carregamento não bloqueie a seleção manual de tamanho.

## Etapa 4 — reduzir Framer Motion global

- Trocar a animação do menu de conta por classes CSS de estado.
- Trocar a rotação da barra promocional por animação CSS respeitando redução de movimento.
- Trocar animações simples do cupom por transições CSS.
- Avaliar `Overlay`, toast, minissacola e progresso de frete; converter apenas quando foco, `inert`, scroll lock e estados de entrada/saída permanecerem equivalentes.
- Não alterar animações editoriais abaixo da dobra nesta rodada se elas já ficarem fora do caminho inicial por divisão de chunks.

## Etapa 5 — fronteiras e carregamento

- Confirmar que o layout público não importa diretamente a implementação completa de chat, cupom ou Fit Assistant.
- Evitar timers que baixem código opcional durante a janela inicial do Lighthouse sem intenção real da cliente.
- Manter tracking e restauração da sacola independentes dos widgets adiados.
- Validar que imports dinâmicos criam chunks separados e não retornam ao bundle compartilhado.

## Etapa 6 — testes e validação funcional

- Testar home, categoria, produto, sacola e checkout em build de produção.
- Validar teclado, foco, Escape, `aria-hidden`, `inert` e `prefers-reduced-motion`.
- Validar abertura da minissacola e persistência dos itens.
- Validar consultora por launcher e convite contextual.
- Validar cupom após tempo + rolagem e ausência nas rotas proibidas.
- Validar Fit Assistant somente após interação.

## Etapa 7 — qualidade e comparação

- Executar `npm run links:check`.
- Executar `npm run lint`.
- Executar `npm test`.
- Executar `npx tsc --noEmit`.
- Executar `npm run build`.
- Comparar chunks e JavaScript inicial com a linha de base.
- Revisar o diff apenas dos arquivos do escopo e documentar resultados e pendências.

## Critérios de conclusão

- Widgets opcionais não participam mais do JavaScript inicial sem necessidade.
- Nenhuma interação crítica de compra perde funcionalidade.
- Não há regressão de acessibilidade identificada nos componentes alterados.
- Testes, typecheck, lint, auditoria de links e build passam, ou falhas preexistentes são comprovadas e isoladas.
- O build demonstra redução mensurável ou fornece evidência objetiva de qual custo obrigatório permaneceu.
