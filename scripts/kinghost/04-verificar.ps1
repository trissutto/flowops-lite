# VERIFICACAO ORIGEM x DESTINO - passo A5 do RUNBOOK-SAIDA-KINGHOST.md
#
# ARQUIVO EM ASCII PURO (sem acento): PowerShell 5.1 le .ps1 como ANSI e acento
# em UTF-8 sem BOM quebra o parser. Nao acrescente acento aqui.
#
# Compara COUNT(*) tabela a tabela entre o Giga da KingHost e o MySQL novo.
#
# Por que COUNT(*) e nao TABLE_ROWS do information_schema: no InnoDB TABLE_ROWS
# e ESTIMATIVA e erra facil 20%. Conferir migracao de banco com estimativa e o
# mesmo que nao conferir.
#
# REGRA DE OURO: qualquer divergencia = NAO VIRA. Restore que "deu certo" mas
# perdeu 300 linhas de caixa vira problema de contabilidade em janeiro, quando
# ninguem lembra mais desta noite.
#
# USO:
#   powershell -ExecutionPolicy Bypass -File .\04-verificar.ps1 `
#     -ErpHost 162.215.213.154 -ErpUser U -ErpDatabase B `
#     -DestHost H -DestUser U -DestDatabase B

param(
  [Parameter(Mandatory = $true)][string]$ErpHost,
  [int]$ErpPort = 3306,
  [Parameter(Mandatory = $true)][string]$ErpUser,
  [Parameter(Mandatory = $true)][string]$ErpDatabase,
  [Parameter(Mandatory = $true)][string]$DestHost,
  [int]$DestPort = 3306,
  [Parameter(Mandatory = $true)][string]$DestUser,
  [Parameter(Mandatory = $true)][string]$DestDatabase,
  [string]$SaidaDir = "$PSScriptRoot\saida"
)

$ErrorActionPreference = 'Stop'

$s1 = Read-Host -AsSecureString 'Senha do MySQL de ORIGEM (KingHost)'
$senhaOrigem = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1))
$s2 = Read-Host -AsSecureString 'Senha do MySQL de DESTINO'
$senhaDestino = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2))

function Consultar([string]$h, [int]$p, [string]$u, [string]$pw, [string]$db, [string]$sql) {
  & mysql "--host=$h" "--port=$p" "--user=$u" "--password=$pw" `
    --batch --skip-column-names --default-character-set=utf8mb4 `
    "--execute=$sql" $db 2>$null
}

Write-Host 'Listando tabelas da origem...' -ForegroundColor Cyan
$qTabelas = "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$ErpDatabase' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;"
$tabelas = Consultar $ErpHost $ErpPort $ErpUser $senhaOrigem $ErpDatabase $qTabelas
if (-not $tabelas) {
  Write-Host 'Nao consegui listar as tabelas da origem.' -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $SaidaDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$relatorio = "$SaidaDir\verificacao-$stamp.tsv"
"tabela`torigem`tdestino`tstatus" | Out-File $relatorio -Encoding utf8

$divergentes = 0
$faltando = 0
$total = 0

foreach ($t in $tabelas) {
  $t = "$t".Trim()
  if (-not $t) { continue }
  $total++

  $o = "$(Consultar $ErpHost  $ErpPort  $ErpUser  $senhaOrigem  $ErpDatabase  "SELECT COUNT(*) FROM ``$t``;")".Trim()
  $d = "$(Consultar $DestHost $DestPort $DestUser $senhaDestino $DestDatabase "SELECT COUNT(*) FROM ``$t``;")".Trim()

  if (-not $d) {
    $status = 'FALTANDO NO DESTINO'; $faltando++
    Write-Host ("{0,-32} {1,12} {2,12}  {3}" -f $t, $o, '-', $status) -ForegroundColor Red
  } elseif ($o -ne $d) {
    $status = 'DIVERGENTE'; $divergentes++
    Write-Host ("{0,-32} {1,12} {2,12}  {3}" -f $t, $o, $d, $status) -ForegroundColor Red
  } else {
    $status = 'ok'
    Write-Host ("{0,-32} {1,12} {2,12}  {3}" -f $t, $o, $d, $status) -ForegroundColor DarkGray
  }
  "$t`t$o`t$d`t$status" | Out-File $relatorio -Encoding utf8 -Append
}

Write-Host ''
Write-Host "$total tabelas conferidas. Relatorio: $relatorio" -ForegroundColor Cyan

if ($divergentes -eq 0 -and $faltando -eq 0) {
  Write-Host ''
  Write-Host 'TUDO BATE. Pode seguir pro passo A6 (trocar as ERP_* no Railway).' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host "NAO VIRE AINDA: $divergentes divergente(s), $faltando faltando." -ForegroundColor Red
  Write-Host ''
  Write-Host 'Causas comuns, na ordem em que costumam aparecer:' -ForegroundColor Yellow
  Write-Host ' - escreveram na origem DEPOIS do dump (loja aberta ou cron ligado)'
  Write-Host '   -> refaz o dump com tudo congelado (passo A3)'
  Write-Host ' - restore interrompido no meio (rede caiu)'
  Write-Host '   -> derruba o database do destino e restaura de novo'
  Write-Host ' - tabela MyISAM dumpada sem --lock-all-tables'
  Write-Host '   -> foto inconsistente; refaz com -Estrategia myisam'
  exit 1
}
