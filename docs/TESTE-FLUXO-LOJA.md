# Teste end-to-end do fluxo /minha-loja

## Passo 1 — Deploy (só hoje, depois é só `atualizar-github.bat`)

Na tua máquina Windows, dentro da pasta do projeto:

```cmd
atualizar-github.bat
```

O script agora faz `git pull --rebase` antes do push, então os 5 commits que
estão à frente no GitHub são sincronizados automaticamente. Coloca uma
mensagem tipo:

```
feat: /minha-loja + pick-orders + socket rooms + presence
```

Railway detecta o push e reconstrói o backend (Dockerfile). Vercel faz o
mesmo com o frontend. Espera 2-3min.

### Verificação rápida depois do deploy

1. Backend:
   `https://<SEU-BACKEND>.up.railway.app/api/health` → JSON com `{"ok":true}`
2. Backend novo endpoint:
   `https://<SEU-BACKEND>.up.railway.app/api/auth/me` com Bearer token →
   retorna `{userId, email, role, storeId}`
3. Frontend: `https://<SEU-FRONTEND>.vercel.app/login` carrega normal.

---

## Passo 2 — Criar user de teste (role=store)

1. Loga no FlowOps como admin
2. Vai em `/usuarios` → **Novo usuário**
3. Preenche:
   - **Email**: `lj01@flowops.local`
   - **Senha**: algo fácil pra testar
   - **Nome**: `Operadora LJ01`
   - **Papel (role)**: `store`
   - **Loja**: Loja 01 Itanhaém
4. Salva. Active = true.

---

## Passo 3 — Testar login como loja

1. Sai e loga com `lj01@flowops.local`
2. Redireciona direto pra `/minha-loja` (se não, digita `/minha-loja` na URL)
3. Header mostra **Online** (bolinha verde) se o socket conectou
4. Lista vazia na primeira vez → "Nenhum pedido pendente"

Abre console (F12) do navegador pra ver logs do socket. Deve mostrar:
```
[socket XYZ] entrou em store:<id-da-lj01>
```

---

## Passo 4 — Disparar pick-order pra loja

**Como admin em outra aba/máquina**:

1. `/separacao` → pega um pedido em `processing`
2. Clica **Preparar** → ve preview com LJ01 como destino
3. Clica **Confirmar** (se não houver esse botão ainda, usa o endpoint
   POST `/api/routing/confirm/:orderId` via curl/Postman)

**Na aba da LJ01** (`/minha-loja`):

Em no máximo 1-2s deve aparecer:
- Toast "Pedido novo #NNN chegou!"
- Title flash 🔔
- Notification do SO (se permitiu)
- Novo card amarelo no topo da lista com status "Novo"

Se NÃO aparecer em tempo real:
- Confere F12 console: deve ter `pick-order:new` no log
- Confere `/api/stores/presence` — a LJ01 deve estar `online: true`
- Confere Railway logs: `[socket XXX] entrou em store:<id>`

---

## Passo 5 — Transições de status

Na aba da LJ01:

1. Clica **Iniciar Separação** no card novo → vira azul "Separando"
2. Clica **Marcar como Pronto** → vira verde "Pronto"
3. Clica **Enviar (rastreio)** → abre modal
   - Tracking: `BR123456789BR`
   - Transportadora: `Correios`
   - Confirma → card some da lista ativa

**Na aba admin** (`/pedidos` ou `/separacao`):
- Se tiver sala `admin` escutando `pick-order:status`, o pedido aparece
  como enviado automaticamente
- O `Order.status` vira `shipped` quando TODOS os pick-orders da ordem
  forem marcados como shipped

---

## Passo 6 — Testar presença

1. Com a LJ01 logada em `/minha-loja`, fecha a aba.
2. **Admin**: GET `/api/stores/presence` (ou dashboard quando tiver)
3. A LJ01 deve aparecer `online: false` + `lastSeen` de poucos segundos atrás.
4. Reabre `/minha-loja` da LJ01 → presença volta pra online em 1s.

---

## Passo 7 — Build do Electron (pra testar na loja)

```cmd
cd desktop-app
npm install
build-desktop.bat
```

Saída: `desktop-app\dist\FlowOps-Setup-1.0.0.exe`.

**Antes do build, joga em `desktop-app\build\`:**
- `icon.ico` (256x256) — ícone do app e do atalho
- `icon-tray.png` (32x32) — ícone da bandeja

Se não tiver os ícones pronto, o build funciona, só fica genérico.

### Instalando na loja

1. Copia `FlowOps-Setup-1.0.0.exe` pra máquina da LJ01
2. Roda → instala no `C:\Users\<user>\AppData\Local\Programs\FlowOps`
3. Abre sozinho após instalar, loga com o user da loja
4. Fecha janela → vai pra bandeja (ícone perto do relógio)
5. Reinicia Windows → app sobe minimizado automaticamente

### Trocar URL do FlowOps (caso mude de domínio)

Clica direito no ícone da bandeja → **Configurar URL...** → cola a URL
nova → OK. Persiste entre reboots.

---

## Checklist final de aceitação

- [ ] User com role=store loga e vai direto pra `/minha-loja`
- [ ] Socket conecta (bolinha verde "Online")
- [ ] Admin confirma roteamento → card aparece na loja em <2s
- [ ] Notification do SO dispara (silent=true, sem som)
- [ ] Transições `new → separating → ready → shipped` funcionam
- [ ] Modal de envio exige tracking + transportadora
- [ ] `GET /api/stores/presence` reflete status correto
- [ ] Electron .exe instalado: auto-start, tray, botão X minimiza pra tray
- [ ] Ctrl+Shift+I abre DevTools no Electron (debug)
