# LURDS ORDER ONE — Como lançar nova versão (auto-update)

Fluxo na nuvem: você dá `git tag v1.0.X && git push --tags` → GitHub Actions
builda o `.exe` em Windows → publica no GitHub Releases → todas as lojas
já instaladas detectam em até 4h e baixam sozinhas em background. A
instalação acontece silenciosamente no próximo restart do PC da loja.

## 1ª vez (setup) — ~5 min

Você já tem tudo no código. Só precisa:

1. **Criar o primeiro Release manualmente no GitHub** (pra app saber que
   o owner/repo existe e tem releases pra olhar):
   - Abre https://github.com/trissutto/flowops-lite/releases/new
   - Tag: `v1.0.0`
   - Title: `LURDS ORDER ONE v1.0.0 — versão inicial`
   - Description: `Versão inicial do app desktop`
   - Clica em "Publish release"

2. **Disparar o workflow uma vez pra subir o instalador** (vai gerar o .exe
   e anexar ao release v1.0.0):
   - Abre Actions: https://github.com/trissutto/flowops-lite/actions
   - "Build Desktop App (Windows)" → "Run workflow" → confirma
   - Aguarda ~6 min (Windows é mais lento que Linux pra build)
   - Quando terminar, vai em Releases — o .exe aparece anexado

3. **Distribui o .exe pras lojas (1x só, depois nunca mais)**:
   - Link permanente: https://github.com/trissutto/flowops-lite/releases/latest
   - Manda no grupo, gerente baixa, instala
   - A partir daí, atualiza sozinho

## Releases seguintes — ~2 min

Toda vez que quiser lançar nova versão:

```bash
# 1. Mexe no código, testa local com: cd desktop-app && npm run dev
# 2. Bumpa a versão no desktop-app/package.json (1.0.0 → 1.0.1 → 1.0.2…)
# 3. Faz commit:
git add -A
git commit -m "chore: bump desktop v1.0.1 — fix X, Y, Z"
git push

# 4. Cria tag e push da tag (isso dispara o build no GitHub Actions):
git tag v1.0.1
git push --tags
```

Aguarda ~6 min. O GitHub Actions builda em Windows, gera o `.exe`, sobe
no Release, e atualiza o `latest.yml`. Todas as lojas vão pegar essa
versão automaticamente em até 4h (ou no próximo restart do app).

## Como verificar se update chegou na loja

No PC da loja, abre o arquivo de log:
```
%APPDATA%\lurds-order-one-desktop\logs\main.log
```

Vai ter linhas tipo:
```
[updater] verificando...
[updater] update disponivel: v1.0.1
[updater] download 100%
[updater] update v1.0.1 baixado — instala no proximo restart
```

## Forçar update agora (sem esperar 4h)

Vendedora reinicia o app (sai pelo tray, abre de novo). Ao abrir, baixa
e aplica em 30s.

## Reverter (rollback)

Se a versão nova quebrar:
1. Deleta o Release no GitHub
2. Lojas vão continuar na versão antiga até você lançar uma nova maior

(Auto-updater não faz downgrade automático — bumpe a próxima versão e
desfaz o problema.)

## Onde olhar se algo der errado

- **Build falha no GitHub Actions** → vai no Actions tab e abre o run
  com X vermelho → lê o log
- **App nas lojas não atualiza** → verifica que existe `latest.yml` no
  Release (sem ele, electron-updater não sabe que versão é a mais nova)
- **Lojas ainda na versão velha após 4h** → confirma que o `package.json`
  do .exe instalado tem `publish` config apontando pro repo certo
