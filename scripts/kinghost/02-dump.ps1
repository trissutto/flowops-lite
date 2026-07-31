<#
  DUMP DO MYSQL DO GIGA — passo A4 do RUNBOOK-SAIDA-KINGHOST.md

  Roda do PC com IP liberado no firewall da KingHost.

  DUAS ESTRATÉGIAS, e a escolha não é opinião — é o engine das tabelas:

    InnoDB  → --single-transaction: tira a foto dentro de uma transação. NÃO
              trava ninguém, a loja continua vendendo durante o dump.
    MyISAM  → --lock-all-tables: MyISAM não tem transação, então a única forma
              de foto consistente é travar tudo. A operação PARA enquanto roda.

  O 01-inventario.ps1 já disse qual é o seu caso. Se ele acusou MyISAM e você
  rodar com -Estrategia innodb, o dump SAI, mas pode conter meia venda — uma
  linha de caixa sem a linha correspondente em outra tabela. É o tipo de erro
  que só aparece semanas depois, na conferência do contador.

  USO — ensaio (lojas abertas, só pra medir tempo e validar o restore):
    .\02-dump.ps1 -ErpHost 162.215.213.154 -ErpUser <user> -ErpDatabase <db>

  USO — dump final (lojas fechadas, depois de congelar as escritas):
    .\02-dump.ps1 -ErpHost ... -ErpUser ... -ErpDatabase ... -Final
#>

param(
  [Parameter(Mandatory = $true)][string]$ErpHost,
  [int]$ErpPort = 3306,
  [Parameter(Mandatory = $true)][string]$ErpUser,
  [Parameter(Mandatory = $true)][string]$ErpDatabase,
  [ValidateSet('innodb', 'myisam')][string]$Estrategia = 'innodb',
  [switch]$Final,
  [string]$SaidaDir = "$PSScriptRoot\saida"
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command mysqldump -ErrorAction SilentlyContinue)) {
  Write-Host "mysqldump nao encontrado no PATH. Instale o MySQL Server/Shell." -ForegroundColor Red
  exit 1
}

if ($Final) {
  Write-Host "=== DUMP FINAL ===" -ForegroundColor Yellow
  Write-Host "Antes de continuar, confirme (passo A3 do runbook):"
  Write-Host "  [ ] Lojas FECHADAS"
  Write-Host "  [ ] Fila do outbox vazia (GET /pdv/erp-outbox)"
  Write-Host "  [ ] WINCRED_MIRROR_CRON_ENABLED=0 no Railway"
  $ok = Read-Host "Tudo confirmado? (digite SIM)"
  if ($ok -ne 'SIM') { Write-Host "Abortado."; exit 1 }
}

$senha = Read-Host -AsSecureString "Senha do MySQL do Giga"
$senhaPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($senha))

New-Item -ItemType Directory -Force -Path $SaidaDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$tag = if ($Final) { 'FINAL' } else { 'ensaio' }
$arquivo = "$SaidaDir\giga-$tag-$stamp.sql"

# --routines --triggers --events: o Giga tem lógica no banco. Dump sem isso
#   restaura os DADOS e perde o COMPORTAMENTO — e a falha aparece só quando
#   alguém dispara a rotina que sumiu.
# --hex-blob: campo binário sobrevive à ida e volta por arquivo texto.
# --default-character-set=utf8mb4: acento de descrição de produto não vira "?".
$flags = @(
  "--host=$ErpHost", "--port=$ErpPort", "--user=$ErpUser", "--password=$senhaPlain",
  '--routines', '--triggers', '--events',
  '--hex-blob', '--quick', '--default-character-set=utf8mb4',
  '--set-gtid-purged=OFF'
)

if ($Estrategia -eq 'innodb') {
  $flags += '--single-transaction'
  Write-Host "Estrategia: InnoDB (sem travar — a loja pode operar durante o dump)" -ForegroundColor Cyan
} else {
  $flags += '--lock-all-tables'
  Write-Host "Estrategia: MyISAM (TRAVA TUDO — ninguem escreve enquanto roda)" -ForegroundColor Yellow
}

Write-Host "Destino: $arquivo"
$inicio = Get-Date

& mysqldump @flags $ErpDatabase | Out-File -FilePath $arquivo -Encoding utf8
if ($LASTEXITCODE -ne 0) {
  Write-Host "mysqldump falhou (exit $LASTEXITCODE). Arquivo NAO confiavel." -ForegroundColor Red
  exit 1
}

$dur = (Get-Date) - $inicio
$mb = [math]::Round((Get-Item $arquivo).Length / 1MB, 1)

Write-Host ""
Write-Host "Dump concluido em $([math]::Round($dur.TotalMinutes,1)) min — $mb MB" -ForegroundColor Green

# A última linha de um dump íntegro é o comentário de fecho do mysqldump.
# Arquivo truncado (conexão caiu no meio) NÃO tem isso — e restaurar um dump
# truncado é pior que não restaurar, porque parece que funcionou.
$ultima = Get-Content $arquivo -Tail 1
if ($ultima -match 'Dump completed') {
  Write-Host "Integridade: OK ('Dump completed' no fim do arquivo)" -ForegroundColor Green
} else {
  Write-Host "!! O arquivo NAO termina com 'Dump completed' — dump truncado." -ForegroundColor Red
  Write-Host "   Nao restaure. Rode de novo." -ForegroundColor Red
  exit 1
}

if (-not $Final) {
  Write-Host ""
  Write-Host "Este foi o ENSAIO. Anote o tempo ($([math]::Round($dur.TotalMinutes,1)) min) —"
  Write-Host "e o tamanho da janela que voce precisa reservar amanha a noite."
}
