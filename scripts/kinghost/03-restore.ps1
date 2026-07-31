# RESTORE NO MYSQL NOVO - passo A4 do RUNBOOK-SAIDA-KINGHOST.md
#
# ARQUIVO EM ASCII PURO (sem acento): PowerShell 5.1 le .ps1 como ANSI e acento
# em UTF-8 sem BOM quebra o parser. Nao acrescente acento aqui.
#
# Rode PRIMEIRO com o dump de ENSAIO. O restore de ensaio e o que descobre
# problema de charset, engine indisponivel ou permissao - e descobrir isso na
# janela da noite, com as lojas fechadas esperando, e o pior momento possivel.
#
# USO:
#   powershell -ExecutionPolicy Bypass -File .\03-restore.ps1 `
#     -Arquivo .\saida\giga-ensaio-20260731-2200.sql `
#     -DestHost HOST -DestPort PORTA -DestUser USUARIO -DestDatabase BANCO

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

# Mesma checagem do 02: dump truncado parece valido ate a metade.
if ((Get-Content $Arquivo -Tail 1) -notmatch 'Dump completed') {
  Write-Host 'O dump nao termina com Dump completed - arquivo truncado.' -ForegroundColor Red
  Write-Host 'Restaurar isso deixa o banco pela metade sem avisar. Abortado.' -ForegroundColor Red
  exit 1
}

if (-not (Get-Command mysql -ErrorAction SilentlyContinue)) {
  Write-Host 'mysql.exe nao encontrado no PATH.' -ForegroundColor Red
  exit 1
}

$senhaSegura = Read-Host -AsSecureString 'Senha do MySQL de DESTINO'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($senhaSegura)
$senha = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)

$mb = [math]::Round((Get-Item $Arquivo).Length / 1MB, 1)
Write-Host "Restaurando $mb MB em $DestHost/$DestDatabase" -ForegroundColor Cyan
Write-Host '(restore costuma demorar MAIS que o dump: reconstroi indice linha a linha)'

$inicio = Get-Date

# utf8mb4: o Giga tem acento em descricao de produto e nome de cliente.
# Charset errado no destino transforma isso em lixo silenciosamente.
$criar = "CREATE DATABASE IF NOT EXISTS ``$DestDatabase`` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"
& mysql "--host=$DestHost" "--port=$DestPort" "--user=$DestUser" "--password=$senha" "--execute=$criar"
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Falha ao criar o database no destino.' -ForegroundColor Red
  exit 1
}

# cmd /c com redirecionamento nativo: Get-Content | mysql funciona, mas em
# arquivo grande o PowerShell processa linha a linha e fica lentissimo.
$cmd = "mysql --host=$DestHost --port=$DestPort --user=$DestUser --password=$senha --default-character-set=utf8mb4 $DestDatabase < `"$Arquivo`""
& cmd /c $cmd
if ($LASTEXITCODE -ne 0) {
  Write-Host "Restore falhou (exit $LASTEXITCODE)." -ForegroundColor Red
  exit 1
}

$dur = [math]::Round(((Get-Date) - $inicio).TotalMinutes, 1)
Write-Host ''
Write-Host "Restore concluido em $dur min" -ForegroundColor Green
Write-Host 'PROXIMO PASSO OBRIGATORIO: .\04-verificar.ps1' -ForegroundColor Yellow
Write-Host 'Sem conferir contagem, "restaurou sem erro" nao significa "restaurou tudo".' -ForegroundColor Yellow
