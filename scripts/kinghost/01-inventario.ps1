<#
  INVENTÁRIO DO MYSQL DO GIGA — passo A1 do RUNBOOK-SAIDA-KINGHOST.md

  Só LÊ. Não altera nada, pode rodar com as lojas abertas.

  Responde as três perguntas que decidem o plano da virada:
    1. Quanto pesa o banco?  → quanto tempo o dump vai levar
    2. Tem tabela MyISAM?    → se tiver, o dump consistente EXIGE travar as
                               tabelas (operação parada durante o dump).
                               Só InnoDB permite --single-transaction, que
                               tira a foto sem travar ninguém.
    3. Quantas linhas por tabela? → é o número que a verificação pós-restore
                               vai comparar. Sem isso, "deu certo" é palpite.

  USO (PowerShell, do PC que tem o IP liberado no firewall da KingHost):
    .\01-inventario.ps1 -ErpHost 162.215.213.154 -ErpUser <user> -ErpDatabase <db>
  A senha é pedida na hora (não fica no histórico do shell nem em arquivo).
#>

param(
  [Parameter(Mandatory = $true)][string]$ErpHost,
  [int]$ErpPort = 3306,
  [Parameter(Mandatory = $true)][string]$ErpUser,
  [Parameter(Mandatory = $true)][string]$ErpDatabase,
  [string]$SaidaDir = "$PSScriptRoot\saida"
)

$ErrorActionPreference = 'Stop'

# mysql.exe precisa estar no PATH. Vem com MySQL Server, MySQL Shell ou
# MariaDB; o HeidiSQL NÃO instala o cliente de linha de comando.
$mysql = (Get-Command mysql -ErrorAction SilentlyContinue)
if (-not $mysql) {
  Write-Host "mysql.exe nao encontrado no PATH." -ForegroundColor Red
  Write-Host "Instale o MySQL Shell/Server, ou rode as queries abaixo no HeidiSQL"
  Write-Host "e salve o resultado — o que importa e o NUMERO, nao a ferramenta."
  Write-Host ""
  Write-Host "  SELECT TABLE_NAME, ENGINE, TABLE_ROWS,"
  Write-Host "         ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,1) AS MB"
  Write-Host "    FROM information_schema.TABLES"
  Write-Host "   WHERE TABLE_SCHEMA = '$ErpDatabase' ORDER BY MB DESC;"
  exit 1
}

$senha = Read-Host -AsSecureString "Senha do MySQL do Giga"
$senhaPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($senha))

New-Item -ItemType Directory -Force -Path $SaidaDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'

function Invoke-Giga([string]$sql) {
  # --batch: saída separada por TAB, sem moldura ASCII (fácil de salvar/comparar)
  $senhaPlain | & mysql --host=$ErpHost --port=$ErpPort --user=$ErpUser `
    --password --batch --raw --default-character-set=utf8mb4 `
    --execute=$sql $ErpDatabase 2>&1
}

Write-Host "== 1. Tamanho e engine por tabela ==" -ForegroundColor Cyan
$sqlTabelas = @"
SELECT TABLE_NAME, ENGINE, TABLE_ROWS,
       ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,1) AS MB
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = '$ErpDatabase'
 ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC;
"@
$tabelas = Invoke-Giga $sqlTabelas
$tabelas | Tee-Object -FilePath "$SaidaDir\tabelas-$stamp.tsv"

Write-Host ""
Write-Host "== 2. Total do banco ==" -ForegroundColor Cyan
$sqlTotal = @"
SELECT COUNT(*) AS tabelas,
       ROUND(SUM(DATA_LENGTH+INDEX_LENGTH)/1024/1024/1024,2) AS GB
  FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$ErpDatabase';
"@
Invoke-Giga $sqlTotal | Tee-Object -FilePath "$SaidaDir\total-$stamp.tsv"

Write-Host ""
Write-Host "== 3. Engines em uso (decide a estrategia do dump) ==" -ForegroundColor Cyan
$sqlEngines = @"
SELECT ENGINE, COUNT(*) AS tabelas
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = '$ErpDatabase' AND ENGINE IS NOT NULL
 GROUP BY ENGINE;
"@
$engines = Invoke-Giga $sqlEngines
$engines | Tee-Object -FilePath "$SaidaDir\engines-$stamp.tsv"

if ($engines -match 'MyISAM') {
  Write-Host ""
  Write-Host "!! ATENCAO: existe tabela MyISAM." -ForegroundColor Yellow
  Write-Host "   MyISAM nao tem transacao: --single-transaction NAO garante foto"
  Write-Host "   consistente. O dump precisa de --lock-all-tables, e enquanto ele"
  Write-Host "   roda NINGUEM escreve — ou seja, a operacao para durante o dump."
  Write-Host "   Planeje a janela com isso em mente (ver A3 no runbook)."
}

Write-Host ""
Write-Host "== 4. Contagem REAL das tabelas criticas ==" -ForegroundColor Cyan
Write-Host "   (TABLE_ROWS do information_schema e ESTIMATIVA no InnoDB;"
Write-Host "    a verificacao pos-restore precisa do COUNT(*) de verdade)"
foreach ($t in @('produtos','estoque','caixa','movimento','clientes','codigos','funcionarios')) {
  $existe = Invoke-Giga "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$ErpDatabase' AND TABLE_NAME='$t';"
  if ($existe -match '1') {
    $n = Invoke-Giga "SELECT COUNT(*) FROM ``$t``;"
    "$t`t$($n | Select-Object -Last 1)" | Tee-Object -FilePath "$SaidaDir\contagens-$stamp.tsv" -Append
  }
}

Write-Host ""
Write-Host "Inventario salvo em $SaidaDir" -ForegroundColor Green
Write-Host "Guarde contagens-$stamp.tsv — e com ele que o 04-verificar.ps1 confere o restore."
