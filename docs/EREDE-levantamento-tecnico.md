# e-Rede no lugar da Pagar.me — levantamento técnico

**Data:** 01/08/2026 · **Motivo declarado:** recusa no cartão · **Status:** levantamento, nada implementado.

---

## Resumo em 5 linhas

A e-Rede resolve **cartão**, não resolve **PIX**, e não tem link de pagamento por API.
Como PIX é **83,5% do seu volume** pela Pagar.me, a troca só faz sentido no pedaço do cartão.
O item que de fato ataca a recusa é o **3DS**, que já está habilitado na sua conta — e ele
pode ser ligado **sem trocar de gateway**. A troca em si não reduz recusa; muda quem recusa.
Recomendação: ligar 3DS onde você já está, medir, e só então decidir a migração.

---

## 1. O que foi medido no seu banco (produção, 90 dias)

| Caminho | Cobranças pagas | Valor | Fatia |
|---|---|---|---|
| PIX | 459 | R$ 129.414,61 | **83,5%** |
| Cartão (checkout) | 116 | R$ 25.472,33 | 16,5% |
| **Total** | **575** | **R$ 154.886,94** | |

Concentração: **loja 01 = R$ 105.586,86 (68%)** — é a live.

Configuração atual: **uma única conta** Pagar.me (`ambiente=live`), **sem `recipientId`**
(nenhum split) e **zero contas por loja** cadastradas. Isso é uma boa notícia: não existe
arquitetura de marketplace/split pra recriar, que costuma ser o que inviabiliza a troca.

⚠️ Achado colateral: `webhook_secret` está **NULL**. O `handleWebhook` só valida a assinatura
se o secret existir → hoje a validação é pulada e qualquer POST no endpoint marca venda como
paga. Independe da decisão da Rede; corrigir de qualquer forma.

## 2. Taxa de aprovação real (extrato de 8 dias, 223 cobranças)

| Recorte | Aprovação |
|---|---|
| Por tentativa | 54,3% |
| **Por cliente** (retentativa contada 1×) | **78,3%** |
| Cartão, por tentativa | 47% |
| PIX, por tentativa | 67% |

**33 recusas trouxeram código 0000 "Transação aprovada com sucesso" do banco** e caíram no
antifraude depois — é a origem do print de boa-fé que a cliente manda.

O número que circulava ("83% de recusa") vinha de 1 dia contando cada retentativa como
cobrança nova. O problema é real, mas menor do que parecia.

---

## 3. O que a e-Rede oferece

Confirmado no **seu próprio painel** (`meu.userede.com.br/ecommerce`, matriz + filiais):
chave de integração, gestão de IPs, identificação na fatura, estorno de venda, captura de
autorização, relatório de vendas, **notificação automática (webhook)**, **tokenização de
bandeira**, **3DS DataOnly** e "faça sua venda".

### Autenticação — mudou

A autenticação antiga (TOKEN + PV) foi descontinuada. Agora é OAuth 2.0:

```
POST https://api.userede.com.br/redelabs/oauth2/token
clientId     = PV
clientSecret = Chave de Integração (Portal Use Rede)
```

O `access_token` expira em ~24 minutos → precisa de cache com renovação.
Prazo oficial da migração era **05/01/2026** — já vencido. **Confirmar com a Rede se a chave
da sua conta já está no padrão novo** antes de qualquer coisa.

### Transação

`POST /v1/transactions` — campos `amount`, `reference`, `cardholderName`, `cardNumber`,
`expiration`, `securityCode`, `installments`, `capture`, `softDescriptor`. Devolve
`returnCode` + `tid`. Existem SDKs oficiais (Node, PHP, Java, Python, C#), mas o de Node
ainda documenta a autenticação antiga e marca 3DS como "descontinuada" — ou seja, **os SDKs
estão atrasados em relação à API**. Integrar direto no HTTP, não via SDK.

### O que a e-Rede NÃO tem

| Recurso | Situação |
|---|---|
| **PIX** | Não aparece no seu painel de e-commerce, não está nos SDKs e não achei documentação pública. Provavelmente é contratação à parte (Pix Itaú/Rede), com outra API e outra credencial. **Confirmar com o gerente.** |
| **Link de pagamento por API** | Não existe. O "faça sua venda" é manual, no portal da Rede. |
| **Antifraude próprio** | O Link de Pagamento Rede tem prevenção inclusa, mas **a responsabilidade do chargeback continua sendo do lojista** em venda não-presencial. |

### ⚠️ A armadilha do "faça sua venda"

Se a troca virar "vendedora gera o link no portal da Rede", você recria exatamente o buraco
que medimos: venda finalizada no PDV sem ninguém conferir se o dinheiro entrou
(R$ 73.443,65 em 30 dias no caminho "Link externo"/"PIX direto"). A trava que hoje funciona
— o PDV não finaliza até a confirmação chegar — só sobrevive se a cobrança for **gerada por
API e confirmada por webhook**. Isso significa: **o Flow passa a hospedar a própria página de
checkout**.

---

## 4. Sobre o 3DS — e por que ele é o ponto central

Você quer atacar recusa. O mecanismo que faz isso é o 3DS, não a troca de gateway:

- **3DS completo (com autenticação)**: o emissor autentica a portadora e, quando autentica,
  **a responsabilidade do chargeback passa pro emissor**. É o que elimina o prejuízo de
  verdade.
- **3DS DataOnly** (o que está no seu painel): manda os dados pro emissor analisar **sem
  desafiar a cliente**. Melhora a chance de aprovação porque o emissor decide com mais
  informação — mas **não costuma transferir a responsabilidade**. Confirmar com a Rede qual
  dos dois o seu contrato cobre.

**O ponto que decide a estratégia:** a Pagar.me também suporta 3DS. Dá pra ligar 3DS **sem
trocar nada**, medir o efeito na aprovação, e só depois decidir a migração. É o teste mais
barato disponível — e ele isola a variável.

E vale a lembrança que já estava na sua nota: 47% de aprovação raramente é fraude real —
costuma ser dado ruim (endereço de cobrança, telefone, CPF, IP/device ausentes) fazendo o
score subir. Abrir chamado na Pagar.me perguntando **quais sinais dispararam** custa zero e
pode resolver mais que a migração inteira.

---

## 5. O que teria que ser reescrito no Flow

Hoje: **249 referências a Pagar.me em 18 arquivos** do backend, mais o app de e-commerce.
Mas a maior parte é config e leitura — o núcleo é pequeno.

### Se migrar SÓ o cartão (recomendado, se migrar)

| Peça | Trabalho |
|---|---|
| Módulo `erede/` novo | OAuth com cache de 24min, `createTransaction`, consulta, cancelamento |
| Página de checkout hospedada pelo Flow | **A peça nova de verdade.** Tokenização no navegador + 3DS. O `CardForm.tsx` do e-commerce já faz esse desenho com a Pagar.me e serve de base |
| Receptor da notificação automática | Endpoint novo + validação (o formato/segurança precisa ser confirmado com a Rede) |
| `pagarme-reconcile.service.ts` | Clonar pra e-Rede — a rede de segurança de 45s não pode ficar só no webhook |
| `pdv` / `live-pdv` | Escolher provedor por meio de pagamento; o fluxo (gera → espera confirmação) não muda de forma |
| `conciliacao` | Fonte nova, `raw_json` da e-Rede |
| `crediario-baixa` | Só se a baixa de crediário por link também for pro cartão |

**PIX e todo o resto ficam na Pagar.me, intocados** — 83% do dinheiro nunca entra em risco.

### Se migrar tudo

Some a isso: achar substituto de PIX (contrato separado), migrar 459 cobranças/90d de PIX,
o e-commerce inteiro (`CardForm`, checkout, docs) e a conciliação dos dois meios. Sem ganho
correspondente — o PIX não tem recusa nem chargeback.

---

## 6. Ordem recomendada

1. **Ligar 3DS na Pagar.me** e medir a aprovação por 2–4 semanas. Zero migração, isola a
   variável, e o script `conferir-vendas-link-nao-pagas.js` já mede o resultado.
2. **Abrir chamado na Pagar.me**: quais sinais estão subindo o score do antifraude.
3. **Perguntar pra Rede** (lista fechada, abaixo).
4. Só então decidir migração — e, se migrar, **só o cartão**.

## 7. Perguntas fechadas pro gerente da Rede

1. A chave de integração da conta 66605261 já está no padrão **OAuth 2.0**? Se não, como migrar?
2. A e-Rede oferece **PIX por API** com QR dinâmico? É o mesmo contrato ou é à parte?
3. O 3DS do nosso contrato é **DataOnly** ou **autenticação completa com transferência de
   responsabilidade**?
4. A **notificação automática** cobre quais eventos, em qual formato, e como validamos que
   a chamada veio mesmo da Rede (assinatura/HMAC/mTLS/IP)?
5. Existe **link de pagamento gerado por API** (não pelo portal)?
6. Qual a **taxa** por bandeira/parcelamento e o **prazo de recebimento** — comparado com a
   maquininha que já roda nas lojas?
7. Cada loja (filial) tem **PV próprio**? Dá pra roteirizar a cobrança por PV da loja que
   vendeu?

---

## Fontes

- Painel e-commerce da conta (print de 01/08/2026, `meu.userede.com.br/ecommerce`)
- [Migração OAuth 2.0 da e.Rede](https://mayconbraga.com.br/blog/conteudo/mudancas-na-api-da-erede-migracao-obrigatoria-para-oauth-20-ate-05-01-2026)
- [SDK Node oficial da Rede](https://github.com/DevelopersRede/erede-node) · [Plataformas e-commerce](https://developer.userede.com.br/plataformas-e-commerce)
- [Link de Pagamento Rede — Itaú Empresas](https://www.itau.com.br/empresas/pagamentos-recebimentos/link-de-pagamento)
- [Antifraude não elimina o risco; responsabilidade é do estabelecimento](https://www.ecommercebrasil.com.br/noticias/antifraude-e-pix-parcelado-tecnologia-para-aumentar-conversao-com-mais-seguranca)
- Medições próprias: `backend/scripts/giga-etl/conferir-vendas-link-nao-pagas.js` e consultas a `pagarme_payments` / `pagarme_config`
