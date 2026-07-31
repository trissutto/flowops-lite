<#
  RESTORE NO MYSQL NOVO — passo A4 do RUNBOOK-SAIDA-KINGHOST.md

  Restaura o dump no MySQL provisionado no Railway (ou onde for o destino novo).

  Rode PRIMEIRO com o dump de ENSAIO, ainda hoje. O restore de ensaio é o que
  descobre problema de charset, engine indisponível ou permissão — e descobrir
  isso amanhã à noite, com as lojas fechadas esperando, é o pior momento
  possível.

  USO:
    .\03-restore.ps1 -Arquivo .\saida\giga-ensaio-20260731-2200.sql `
                     -DestHost <host> -DestPort <porta> `
                     -DestUser <user> -DestDatabase <db>
#>

param(
  [Parameter(Mandatory = $true)][string]$Arquivo,
  [Parameter(Mandatory = $true)][string]$DestHost,
  [int]$DestPort = 3306,
  [Parameter(Mandatory = $true)][string]$DestUser,
  [Parameter(Mandatory = $true)][string]$DestDatabase
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Arquivo)) {
  Write-Host "Arquivo nao encontrado: $Arquivo" -ForegroundColor Red
  exit 1
}

# Mesma checagem do 02: dump truncado parece válido até a metade.
if ((Get-Content $Arquivo -Tail 1) -notmatch 'Dump completed') {
  Write-Host "O dump nao termina com 'Dump completed' — arquivo truncado." -ForegroundColor Red
  Write-Host "Restaurar isso deixa o banco pela metade sem avisar. Abortado." -ForegroundColor Red
  exit 1
}

if (-not (Get-Command mysql -ErrorAction SilentlyContinue)) {
  Write-Host "mysql.exe nao encontrado no PATH." -ForegroundColor Red
  exit 1
}

$senha = Read-Host -AsSecureString "Senha do MySQL de DESTINO"
$senhaPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($senha))

$mb = [math]::Round((Get-Item $Arquivo).Length / 1MB, 1)
Write-Host "Restaurando $mb MB em $DestHost/$DestDatabase" -ForegroundColor Cyan
Write-Host "(um banco grande leva MAIS tempo pra restaurar do que levou pra dumpar —"
Write-Host " o restore reconstroi indice linha a linha)"

$inicio = Get-Date

# O database precisa existir antes. utf8mb4 + collation geral: o Giga tem
# acento em descrição de produto e nome de cliente, e charset errado no
# destino transforma isso em lixo silenciosamente.
$criar = "CREATE DATABASE IF NOT EXISTS ``$DestDatabase`` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"
& mysql --host=$DestHost --port=$DestPort --user=$DestUser --password=$senhaPlain --execute=$criar
if ($LASTEXITCODE -ne 0) { Write-Host "Falha ao criar o database." -ForegroundColor Red; exit 1 }

# Get-Content | mysql funciona, mas em arquivo grande o PowerShell processa
# linha a linha e fica LENTO. `cmd /c <` usa redirecionamento nativo.
$cmd = "mysql --host=$DestHost --port=$DestPort --user=$DestUser --password=$senhaPlain --default-character-set=utf8mb4 $DestDatabase < `"$Arquivo`""
& cmd /c $cmd

if ($LASTEXITCODE -ne 0) {
  Write-Host "Restore falhou (exit $LASTEXITCODE)." -ForegroundColor Red
  exit 1
}

$dur = (Get-Date) - $inicio
Write-Host ""
Write-Host "Restore concluido em $([math]::Round($dur.TotalMinutes,1)) min" -ForegroundColor Green
Write-Host "PROXIMO PASSO OBRIGATORIO: .\04-verificar.ps1 — sem conferir contagem," -ForegroundColor Yellow
Write-Host "'restaurou sem erro' nao significa 'restaurou tudo'." -ForegroundColor Yellow
