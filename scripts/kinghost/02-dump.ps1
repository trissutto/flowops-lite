# DUMP DO MYSQL DO GIGA - passo A4 do RUNBOOK-SAIDA-KINGHOST.md
#
# ARQUIVO EM ASCII PURO (sem acento) de proposito: PowerShell 5.1 le .ps1 como
# ANSI e acento em UTF-8 sem BOM quebra o parser. Nao acrescente acento aqui.
#
# DUAS ESTRATEGIAS, e a escolha nao e opiniao - e o engine das tabelas:
#   InnoDB -> --single-transaction: foto dentro de uma transacao, NAO trava
#             ninguem. A loja continua vendendo durante o dump.
#   MyISAM -> --lock-all-tables: MyISAM nao tem transacao, entao a unica forma
#             de foto consistente e travar tudo. A operacao PARA enquanto roda.
#
# O 01-inventario.ps1 ja disse qual e o seu caso. Rodar innodb num banco MyISAM
# gera um dump que SAI sem erro e pode conter meia venda - linha de caixa sem a
# contrapartida em outra tabela. Erro que so aparece na conferencia do contador.
#
# USO - ensaio (lojas abertas, so pra medir tempo e validar o restore):
#   powershell -ExecutionPolicy Bypass -File .\02-dump.ps1 `
#     -ErpHost 162.215.213.154 -ErpUser USUARIO -ErpDatabase BANCO
#
# USO - final (lojas fechadas, depois de congelar as escritas):
#   ... mesmos parametros -Final

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
  Write-Host 'mysqldump nao encontrado no PATH.' -ForegroundColor Red
  Write-Host 'Instale o MySQL Shell ou o MySQL Server (Community) e rode de novo.'
  exit 1
}

if ($Final) {
  Write-Host '=== DUMP FINAL ===' -ForegroundColor Yellow
  Write-Host 'Confirme antes de continuar (passo A3 do runbook):'
  Write-Host '  [ ] Lojas FECHADAS'
  Write-Host '  [ ] Fila do outbox vazia (GET /pdv/erp-outbox)'
  Write-Host '  [ ] WINCRED_MIRROR_CRON_ENABLED=0 no Railway'
  if ((Read-Host 'Tudo confirmado? digite SIM') -ne 'SIM') {
    Write-Host 'Abortado.'; exit 1
  }
}

$senhaSegura = Read-Host -AsSecureString 'Senha do MySQL do Giga'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($senhaSegura)
$senha = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)

New-Item -ItemType Directory -Force -Path $SaidaDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$tag = if ($Final) { 'FINAL' } else { 'ensaio' }
$arquivo = "$SaidaDir\giga-$tag-$stamp.sql"

# --routines --triggers --events: o Giga tem logica no banco. Dump sem isso
#   restaura os DADOS e perde o COMPORTAMENTO, e a falha aparece so quando
#   alguem dispara a rotina que sumiu.
# --hex-blob: campo binario sobrevive a ida e volta por arquivo texto.
# --default-character-set=utf8mb4: acento de descricao de produto nao vira "?".
$flags = @(
  "--host=$ErpHost", "--port=$ErpPort", "--user=$ErpUser", "--password=$senha",
  '--routines', '--triggers', '--events',
  '--hex-blob', '--quick', '--default-character-set=utf8mb4',
  '--set-gtid-purged=OFF'
)

if ($Estrategia -eq 'innodb') {
  $flags += '--single-transaction'
  Write-Host 'Estrategia: InnoDB - sem travar, a loja pode operar durante o dump' -ForegroundColor Cyan
} else {
  $flags += '--lock-all-tables'
  Write-Host 'Estrategia: MyISAM - TRAVA TUDO, ninguem escreve enquanto roda' -ForegroundColor Yellow
}

Write-Host "Destino: $arquivo"
Write-Host 'Rodando... (nao feche a janela)'
$inicio = Get-Date

& mysqldump @flags $ErpDatabase | Out-File -FilePath $arquivo -Encoding utf8
if ($LASTEXITCODE -ne 0) {
  Write-Host "mysqldump falhou (exit $LASTEXITCODE). Arquivo NAO confiavel." -ForegroundColor Red
  exit 1
}

$dur = [math]::Round(((Get-Date) - $inicio).TotalMinutes, 1)
$mb = [math]::Round((Get-Item $arquivo).Length / 1MB, 1)
Write-Host ''
Write-Host "Dump concluido em $dur min - $mb MB" -ForegroundColor Green

# Dump integro termina com o comentario de fecho do mysqldump. Arquivo truncado
# (conexao caiu no meio) nao tem isso - e restaurar truncado e pior que nao
# restaurar, porque parece que funcionou.
if ((Get-Content $arquivo -Tail 1) -match 'Dump completed') {
  Write-Host "Integridade: OK ('Dump completed' no fim do arquivo)" -ForegroundColor Green
} else {
  Write-Host '!! Arquivo NAO termina com Dump completed - dump truncado.' -ForegroundColor Red
  Write-Host '   Nao restaure. Rode de novo.' -ForegroundColor Red
  exit 1
}

if (-not $Final) {
  Write-Host ''
  Write-Host "Foi o ENSAIO. Anote: $dur min de dump."
  Write-Host 'Some o tempo do restore (costuma ser 1,5x a 3x isso) para saber'
  Write-Host 'a janela que precisa reservar.'
}
