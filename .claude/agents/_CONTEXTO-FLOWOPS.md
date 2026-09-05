# Contexto compartilhado da equipe de frontend (não é um agente — é referência)

Todo agente de frontend deste projeto carrega o bloco abaixo. Se algo aqui ficar
desatualizado, corrija AQUI e propague para os arquivos de agente.

## O que é

FlowOps Lite — sistema da rede **Lurd's Plus Size** (moda plus size, lojas físicas +
e-commerce). O alvo desta equipe é `frontend/` (Next.js 14 App Router, deploy Vercel),
NÃO o `ecommerce/` (site público, outro projeto, outras convenções).

**De onde vem o dado da tela:** do **Postgres do Flow** — o ERP legado não é fonte de
nada. O ERP (MySQL Giga/Wincred) e o WordPress/WooCommerce foram **encerrados em
27/08/2026** e nenhum dos dois é alcançável. Nenhum texto de tela pode mandar a vendedora
"conferir no Giga", "lançar no Wincred" ou abrir o WordPress — é ordem impossível, e ela
trava tentando cumprir. Rótulos e nomes de tela que ainda dizem Giga/Wincred são herança
de nome: as tabelas `wincred_*` / `giga_*` são espelhos **nativos** alimentados pelo
próprio Flow.

🚨 **Ao matar uma ordem impossível, ponha no lugar o que resolve HOJE** — o passo que
existe na tela (dar entrada/baixa no próprio Flow, refazer o bipe, o botão que já está
ali) ou quem avisar (matriz/retaguarda). Texto vazio no lugar da ordem impossível é a
mesma vendedora travada, só que sem pista nenhuma.

## Quem usa (e em que condição)

| Perfil | Onde | Condição real |
|---|---|---|
| Vendedora | PDV, `/minha-loja` | **em pé, no balcão, com cliente esperando**. Erra sob pressão. |
| Gerente de loja | `/minha-loja/*` | entre atender e resolver pendência; celular e PC |
| Retaguarda/matriz | `/retaguarda/*` | sentada, tela grande, volume alto de linhas |
| Dono (Thiago) | `/visao-geral`, `/retaguarda` | quer número certo e recorte de data livre |

A diretriz de produto do dono (11/08/2026): **sistema fácil > sistema completo. As
meninas não são o problema, os degraus invisíveis são.**

## Estado real do código (medido 19/08/2026 — não é opinião)

- **Não existe design system.** `tailwind.config.ts` estende só `brand` (#1F4E79).
  Todo o resto é cor arbitrária inline: `bg-[#0B0B0B]`, `text-[#D4AF37]`, `border-[#2A2A2A]`.
- **Não existe primitivo.** `src/components/` = 34 arquivos soltos (AdminShell, KpiCard,
  HubCard, SideNav...). Nenhum Button, Input, Select, Card, Modal, Table, Badge.
  Cada tela redesenha o seu botão.
- `app/globals.css` = 1.247 linhas. Inclui o bloco `.pdv-lab`, que remapeia a paleta
  escura do PDV para vinho/dourado/creme sobrescrevendo **classes arbitrárias escapadas**
  (`.pdv-lab .bg-\[\#0B0B0B\] { ... !important }`). É deliberado e reversível
  (remover `.pdv-lab` do root) — **não desmontar sem combinar com o dono.**
- **Arquivos gigantes:** `minha-loja/pdv/page.tsx` 10.590 linhas · `live-pdv` 4.653 ·
  `retaguarda/distribuicao-estoque` 3.269 · `pedidos/wc/[id]` 2.996 · `minha-loja` 2.948.
  Total: 243 telas, ~165 mil linhas de TSX.
- **Stack disponível:** clsx, tailwind-merge, framer-motion, lucide-react, recharts,
  swr, socket.io-client, qrcode. **Sem radix, sem shadcn, sem headless-ui.**
  Não introduzir lib de UI nova sem aprovação explícita.

## Regras de produto inegociáveis

1. **Filtro de tempo** = dois `<input type="date">` De/Até + atalhos Hoje · Ontem ·
   7 dias · Mês. **NUNCA** `<select>` de períodos fixos. Referência canônica:
   `frontend/src/app/retaguarda/faturamento/page.tsx`. Default = mês corrente.
2. **Tela para loja = tarefa clicável, não menu.** A home `/minha-loja` abre com a fila
   "O QUE FAZER AGORA". Vermelho = parado, amarelo = a fazer, **teto de 10 linhas +
   "ver as outras N"**.
3. **Alarme falso mata a fila inteira.** Tarefa só entra se for pendência real PRA
   AQUELA loja. Já queimou: "Gerar etiqueta" virou parede vermelha falsa em Itanhaém.
4. **Nenhum passo manual novo sem alerta de esquecimento.**
5. **Tarefa tem que cair onde a ação existe** — deep-link para a aba certa, e o
   parâmetro de URL é lido em `useEffect`, **nunca** no initializer do `useState`
   (na navegação client-side do Next o componente monta ANTES da URL trocar).
6. **PDV tema claro:** fundo `#FAFAF7`; dourado como acento `#D4AF37` / `#B8912B` /
   `#8C7325`, hover `#FBF6E6`; **verde `#2E7D46` só para dinheiro** (total, Finalizar).
7. **Vendedora** é escolhida no popup central CONFIRMAR VENDA, na finalização.
   O seletor do canto e o atalho F9 foram removidos em 27/06 — **não ressuscitar**.
8. **Modo treinamento** (`isTraining`) nunca toca estoque nem NFC-e.
9. Deploy exige **hard-refresh** nos PCs de loja — avisar quando a mudança for no PDV.
   Mudança só de `frontend/` **não reinicia o backend** (Vercel; o `railway.json` só
   observa `backend/**`), então não precisa esperar janela. A janela de deploy do
   `CLAUDE.md` (almoço ou depois das 19h30) vale pro **backend**.

## Pegadinhas técnicas já pagas (não repetir)

- **Componente declarado DENTRO de outro componente** remonta a cada render: o input
  perde o foco e só aceita a primeira letra (e o campo de data engole o ano). Qualquer
  componente com `<input>`/`<select>` vai para o **escopo do módulo**, sempre.
  Assinatura do sintoma: "só deixa digitar 1 letra".
- **`tailwind-merge` come classe customizada** que ele não conhece: `text-*` serve para
  tamanho E cor, e diante de dois nomes custom ele mantém só o último. Sintoma: botão
  preto sem texto. Diagnóstico: ler `element.className` no DOM — nenhuma inspeção de
  estilo mostra isso.
- **Form da retaguarda:** no `useEffect` que recarrega a lista, preserve o que está
  sendo **DIGITADO** e deixe entrar o que o **SERVIDOR** resolve. Se preservar tudo,
  salvar parece não ter salvo. Padrão em `categorias`, `banners`, `vitrines-home`.
- **`setValue` do React Hook Form em campo ainda não montado some em silêncio** — o RHF
  restaura do `defaultValues` quando o input monta. Guardar em estado e aplicar num
  `useEffect` que depende do booleano de visibilidade.
- **Error de ESLint derruba o `next build` na Vercel** (warning passa). `tsc --noEmit`
  NÃO basta. Validar com `npm run build` — e redirecionar para arquivo, porque com pipe
  o `$?` é do `tail` e o build "passa" com exit 0 falso.
- **`npm run build` com o dev server de pé corrompe o `.next`** compartilhado
  ("Cannot find module './5519.js'"). Parar o preview, apagar `.next`, subir de novo.
- **Lista sem teto é lista inútil** — loja grande gerou 50 linhas na fila.

## Protocolo com o dono

Sem textão. Resposta curta (~5 linhas fora de emergência). Feature nova ou tela nova:
**perguntar com 2-4 alternativas objetivas ANTES de construir**, uma rodada por vez.

Entrega em branch + push + PR para `main`. **Commit, merge e deploy são automáticos**
(ordem do dono, 22/08/2026) — não perguntar "posso mergear?". O `gh` CLI **está**
instalado e autenticado: `gh pr create` + `gh pr merge --squash --delete-branch`. Se o
push for bloqueado, entregar na branch com o link
`https://github.com/trissutto/flowops-lite/pull/new/<branch>`. Verificar antes
(`npm run build`) continua obrigatório. Ver `CLAUDE.md` para a janela de deploy.
