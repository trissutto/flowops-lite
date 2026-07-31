<#
  VERIFICAÇÃO ORIGEM × DESTINO — passo A5 do RUNBOOK-SAIDA-KINGHOST.md

  Compara COUNT(*) tabela a tabela entre o Giga da KingHost e o MySQL novo.

  Por que COUNT(*) e não o TABLE_ROWS do information_schema: no InnoDB o
  TABLE_ROWS é ESTIMATIVA, e pode errar 20% pra mais ou pra menos. Conferir
  migração de banco com estimativa é o mesmo que não conferir.

  REGRA DE OURO: qualquer divergência = NÃO VIRA. Investigue antes.
  Restore que "deu certo" mas perdeu 300 linhas de caixa vira problema de
  contabilidade em janeiro, quando ninguém lembra mais desta noite.

  USO:
    .\04-verificar.ps1 -ErpHost 162.215.213.154 -ErpUser <u> -ErpDatabase <db> `
                       -DestHost <h> -DestUser <u> -DestDatabase <db>
#>

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

$senhaOrigem = Read-Host -AsSecureString "Senha do MySQL de ORIGEM (KingHost)"
$senhaOrigemPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($senhaOrigem))
$senhaDestino = Read-Host -AsSecureString "Senha do MySQL de DESTINO"
$senhaDestinoPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($senhaDestino))

function Consultar([string]$h, [int]$p, [string]$u, [string]$pw, [string]$db, [string]$sql) {
  $r = & mysql --host=$h --port=$p --user=$u --password=$pw `
    --batch --skip-column-names --default-character-set=utf8mb4 `
    --execute=$sql $db 2>$null
  return $r
}

Write-Host "Listando tabelas da origem..." -ForegroundColor Cyan
$tabelas = Consultar $ErpHost $ErpPort $ErpUser $senhaOrigemPlain $ErpDatabase `
  "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$ErpDatabase' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;"

if (-not $tabelas) { Write-Host "Nao consegui listar as tabelas da origem." -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $SaidaDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$relatorio = "$SaidaDir\verificacao-$stamp.tsv"
"tabela`torigem`tdestino`tstatus" | Out-File $relatorio -Encoding utf8

$divergentes = 0
$faltando = 0
$total = 0

foreach ($t in $tabelas) {
  $t = $t.Trim()
  if (-not $t) { continue }
  $total++

  $o = Consultar $ErpHost $ErpPort $ErpUser $senhaOrigemPlain $ErpDatabase "SELECT COUNT(*) FROM ``$t``;"
  $d = Consultar $DestHost $DestPort $DestUser $senhaDestinoPlain $DestDatabase "SELECT COUNT(*) FROM ``$t``;"

  $oN = ($o | Select-Object -Last 1)
  $dN = ($d | Select-Object -Last 1)

  if (-not $dN) {
    $status = 'FALTANDO NO DESTINO'
    $faltando++
    Write-Host ("{0,-32} {1,12} {2,12}  {3}" -f $t, $oN, '-', $status) -ForegroundColor Red
  } elseif ("$oN" -ne "$dN") {
    $status = 'DIVERGENTE'
    $divergentes++
    Write-Host ("{0,-32} {1,12} {2,12}  {3}" -f $t, $oN, $dN, $status) -ForegroundColor Red
  } else {
    $status = 'ok'
    Write-Host ("{0,-32} {1,12} {2,12}  {3}" -f $t, $oN, $dN, $status) -ForegroundColor DarkGray
  }
  "$t`t$oN`t$dN`t$status" | Out-File $relatorio -Encoding utf8 -Append
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "$total tabelas conferidas"
Write-Host "Relatorio: $relatorio"

if ($divergentes -eq 0 -and $faltando -eq 0) {
  Write-Host ""
  Write-Host "TUDO BATE. Pode seguir pro passo A6 (trocar as ERP_* no Railway)." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "NAO VIRE AINDA: $divergentes divergente(s), $faltando faltando." -ForegroundColor Red
  Write-Host ""
  Write-Host "Causas comuns, na ordem em que costumam aparecer:" -ForegroundColor Yellow
  Write-Host " - alguem escreveu na origem DEPOIS do dump (loja aberta, cron ligado)"
  Write-Host "   -> refaz o dump com tudo congelado (passo A3)"
  Write-Host " - restore interrompido no meio (rede caiu)"
  Write-Host "   -> derruba o database do destino e restaura de novo"
  Write-Host " - tabela MyISAM dumpada sem --lock-all-tables"
  Write-Host "   -> foto inconsistente; refaz com -Estrategia myisam"
  exit 1
}
