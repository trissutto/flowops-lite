# Guia de Integração — WooCommerce + ERP gigasistemas21

Este guia descreve o passo a passo para plugar o FlowOps no seu WordPress/WooCommerce e no MySQL da gigasistemas21. Todas as credenciais ficam no arquivo `.env`.

---

## 1. WooCommerce — gerar chaves da API REST

1. Entre em **WP Admin → WooCommerce → Ajustes → Avançado → API REST**.
2. Clique **Adicionar chave**.
3. Preencha:
   - Descrição: `FlowOps`
   - Usuário: seu usuário admin
   - Permissões: **Leitura/Escrita**
4. Clique **Gerar chave API**.
5. Copie `Consumer key` (ck_...) e `Consumer secret` (cs_...).
6. No `.env` do FlowOps:
   ```
   WC_URL=https://seusite.com.br
   WC_CONSUMER_KEY=ck_xxxxxxxxxxxx
   WC_CONSUMER_SECRET=cs_xxxxxxxxxxxx
   ```

> Nunca exponha essas chaves no frontend ou em repositório público.

---

## 2. WooCommerce — criar webhooks

O WooCommerce dispara HTTP POST no FlowOps a cada novo pedido.

1. **WP Admin → WooCommerce → Ajustes → Avançado → Webhooks**.
2. Clique **Adicionar webhook**.
3. Preencha:
   - Nome: `FlowOps - Novo pedido`
   - Status: **Ativo**
   - Tópico: **Pedido criado**
   - URL de entrega: `https://seu-flowops/api/webhooks/woocommerce`
   - Segredo: **mesmo valor** de `WC_WEBHOOK_SECRET` no `.env`
   - Versão da API: `WP REST API Integration v3`
4. Salve.
5. Repita criando outro webhook com Tópico **Pedido atualizado**.

### 2.1 Expondo o FlowOps em desenvolvimento local

O WooCommerce só aceita URLs HTTPS acessíveis pela internet. Em dev, use **ngrok**:

```bash
# instale: https://ngrok.com/download
ngrok http 3001
# Ex.: https://1234-56-78.ngrok-free.app
```

No webhook, use:
```
https://1234-56-78.ngrok-free.app/api/webhooks/woocommerce
```

### 2.2 Teste do webhook

Depois de criar, clique no ícone de raio no webhook — WooCommerce envia um payload de teste. Confira nos logs do FlowOps:

```bash
docker compose logs -f backend | grep webhook
```

Ou acesse o menu `Logs` no dashboard — todo webhook recebido fica auditado em `integration_logs`.

---

## 3. WooCommerce Shipment Tracking (opcional mas recomendado)

Para que o código de rastreio apareça para o cliente no e-mail e na conta dele, instale o plugin oficial:

1. **WP Admin → Plugins → Adicionar novo** → procure **Shipment Tracking**.
2. Instale e ative.
3. O FlowOps já grava o rastreio nos metadados `_tracking_number` e `_tracking_carrier`, que são exatamente os campos que o plugin lê.

Se preferir outro plugin (Correios, Melhor Envio), ajuste os nomes dos metadados em `backend/src/woocommerce/woocommerce.service.ts` → método `setTracking()`.

---

## 4. ERP gigasistemas21 (MySQL)

### 4.1 Credenciais

O sistema precisa de um usuário **somente-leitura** no MySQL do ERP. Nunca dê permissão de escrita — o FlowOps jamais escreve no ERP.

Peça para o DBA do gigasistemas21 criar:

```sql
CREATE USER 'flowops_reader'@'%' IDENTIFIED BY 'UMA-SENHA-FORTE-AQUI';
GRANT SELECT ON nome_do_banco.* TO 'flowops_reader'@'%';
FLUSH PRIVILEGES;
```

No `.env` do FlowOps:
```
ERP_HOST=mysql.gigasistemas21.com.br
ERP_PORT=3306
ERP_USER=flowops_reader
ERP_PASSWORD=sua-senha-forte
ERP_DATABASE=nome_do_banco
```

### 4.2 Schema esperado

O código em `backend/src/erp/erp.service.ts` assume a seguinte forma de consulta:

```sql
SELECT sku, loja_codigo AS storeCode, quantidade_disponivel AS availableQty
  FROM v_estoque_por_loja
 WHERE sku IN (?)
   AND loja_codigo IN (?)
   AND quantidade_disponivel > 0;
```

Se as tabelas/colunas reais tiverem nomes diferentes, peça para o DBA criar uma **VIEW** chamada `v_estoque_por_loja` com esses 3 campos. Isso evita que tenhamos que ajustar o código toda vez que o ERP mudar internamente.

### 4.3 Código das lojas

Os códigos na coluna `loja_codigo` do ERP precisam **bater exatamente** com os códigos cadastrados no FlowOps (tabela `stores.code`). No seed inicial usamos `LJ01`, `LJ02`, etc. — ajuste em `backend/prisma/seed.ts` para os códigos reais do ERP antes de rodar em produção.

---

## 5. Fluxo end-to-end de um pedido

Com tudo configurado, este é o caminho que um pedido percorre:

1. Cliente finaliza compra no site → WooCommerce cria pedido.
2. WooCommerce dispara `order.created` no webhook do FlowOps.
3. FlowOps valida HMAC, grava o pedido, enfileira `route-order`.
4. Worker consulta estoque no ERP (cache 30s) e roda o Routing Engine.
5. Engine decide: `single-store` ou `multi-store`.
6. FlowOps cria `pick_orders` para cada loja envolvida.
7. Dashboard recebe `order:new` via Socket.IO → toca som, mostra card.
8. Operador da loja atualiza status: `new → separating → ready → shipped`.
9. Quando status vira `shipped` com rastreio, worker `sync-wc` faz PUT no WC:
   - muda status WC para `completed`
   - grava `_tracking_number` no pedido
10. Cliente recebe e-mail do WooCommerce com o rastreio.

---

## 6. Troubleshooting comum

| Sintoma | Causa provável | Solução |
|---|---|---|
| `Invalid signature` nos logs | `WC_WEBHOOK_SECRET` não bate com o segredo cadastrado no webhook | Abra o webhook no WP e confira letra por letra |
| Webhook recebido mas sem roteamento | Pedido não estava em status `pending` | Verifique se o plano de pagamento gera pedido em `pending` ou `processing` |
| `ERP MySQL não conectou` | Firewall do gigasistemas21 bloqueia o IP do servidor | Peça liberação do IP fixo de produção |
| Dashboard não atualiza em tempo real | Socket.IO não conectou | Confira `NEXT_PUBLIC_WS_URL` no `.env` e CORS no backend |
| Status não atualiza no WooCommerce | Worker `sync-wc` ainda é TODO | Ver roadmap §10.4 do doc de arquitetura — finalizar implementação |

---

## 7. Segurança — checklist antes de produção

- [ ] Trocar `JWT_SECRET` por 64 chars aleatórios (`openssl rand -hex 32`).
- [ ] Trocar senha do admin padrão.
- [ ] Firewall liberando só 443 + IPs confiáveis para admin.
- [ ] HTTPS válido (Let's Encrypt / Caddy / Cloudflare).
- [ ] Backup automático do Postgres (script `pg_dump` diário).
- [ ] Sentry ou similar para captura de erros.
- [ ] `.env` nunca commitado (já está no `.gitignore`).
- [ ] Credenciais do ERP rotacionadas a cada 90 dias.
