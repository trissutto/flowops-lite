# INVENTARIO DO MYSQL DO GIGA - passo A1 do RUNBOOK-SAIDA-KINGHOST.md
#
# ATENCAO: este arquivo e ASCII PURO de proposito (sem acento). O Windows
# PowerShell 5.1 le .ps1 como ANSI quando nao ha BOM; acento em UTF-8 vira
# byte invalido e quebra o parser com erro que nao faz sentido nenhum
# ("a palavra-chave 'from' nao tem suporte"). Nao acrescente acento aqui.
#
# So LE. Nao altera nada, pode rodar com as lojas abertas.
#
# Responde as tres perguntas que decidem o plano da virada:
#   1. Quanto pesa o banco?   -> quanto tempo o dump vai levar
#   2. Tem tabela MyISAM?     -> se tiver, dump consistente EXIGE travar as
#                                tabelas (operacao parada durante o dump).
#                                So InnoDB aceita --single-transaction, que
#                                tira a foto sem travar ninguem.
#   3. Quantas linhas?        -> e o numero que a verificacao pos-restore
#                                compara. Sem isso, "deu certo" e palpite.
#
# USO (do PC com IP liberado no firewall da KingHost):
#   powershell -ExecutionPolicy Bypass -File .\01-inventario.ps1 `
#     -ErpHost 162.215.213.154 -ErpUser USUARIO -ErpDatabase BANCO

param(
  [Parameter(Mandatory = $true)][string]$ErpHost,
  [int]$ErpPort = 3306,
  [Parameter(Mandatory = $true)][string]$ErpUser,
  [Parameter(Mandatory = $true)][string]$ErpDatabase,
  [string]$SaidaDir = "$PSScriptRoot\saida"
)

$ErrorActionPreference = 'Stop'

# mysql.exe vem com MySQL Server, MySQL Shell ou MariaDB.
# O HeidiSQL NAO instala o cliente de linha de comando.
if (-not (Get-Command mysql -ErrorAction SilentlyContinue)) {
  Write-Host "mysql.exe nao encontrado no PATH." -ForegroundColor Red
  Write-Host ""
  Write-Host "Rode estas queries no HeidiSQL/Workbench e me mande o resultado."
  Write-Host "O que importa e o NUMERO, nao a ferramenta:"
  Write-Host ""
  Write-Host "  -- 1) tamanho e engine por tabela"
  Write-Host "  SELECT TABLE_NAME, ENGINE, TABLE_ROWS,"
  Write-Host "         ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,1) AS MB"
  Write-Host "    FROM information_schema.TABLES"
  Write-Host "   WHERE TABLE_SCHEMA='$ErpDatabase'"
  Write-Host "   ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC;"
  Write-Host ""
  Write-Host "  -- 2) total do banco"
  Write-Host "  SELECT COUNT(*) AS tabelas,"
  Write-Host "         ROUND(SUM(DATA_LENGTH+INDEX_LENGTH)/1024/1024/1024,2) AS GB"
  Write-Host "    FROM information_schema.TABLES WHERE TABLE_SCHEMA='$ErpDatabase';"
  Write-Host ""
  Write-Host "  -- 3) engines em uso (decide a estrategia do dump)"
  Write-Host "  SELECT ENGINE, COUNT(*) FROM information_schema.TABLES"
  Write-Host "   WHERE TABLE_SCHEMA='$ErpDatabase' AND ENGINE IS NOT NULL GROUP BY ENGINE;"
  exit 1
}

$senhaSegura = Read-Host -AsSecureString 'Senha do MySQL do Giga'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($senhaSegura)
$senha = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)

New-Item -ItemType Directory -Force -Path $SaidaDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'

# --batch: saida separada por TAB, sem moldura ASCII (facil de salvar e comparar)
function Consultar([string]$sql) {
  & mysql "--host=$ErpHost" "--port=$ErpPort" "--user=$ErpUser" "--password=$senha" `
    --batch --skip-column-names --default-character-set=utf8mb4 `
    "--execute=$sql" $ErpDatabase 2>$null
}

Write-Host ''
Write-Host '== 1. Tamanho e engine por tabela ==' -ForegroundColor Cyan
$q1 = "SELECT TABLE_NAME, ENGINE, TABLE_ROWS, ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,1) AS MB FROM information_schema.TABLES WHERE TABLE_SCHEMA='$ErpDatabase' ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC;"
$tabelas = Consultar $q1
if (-not $tabelas) {
  Write-Host 'Nenhum resultado. Conexao recusada, senha errada ou IP fora da whitelist.' -ForegroundColor Red
  exit 1
}
$tabelas | ForEach-Object { Write-Host "  $_" }
$tabelas | Out-File "$SaidaDir\tabelas-$stamp.tsv" -Encoding utf8

Write-Host ''
Write-Host '== 2. Total do banco ==' -ForegroundColor Cyan
$q2 = "SELECT COUNT(*), ROUND(SUM(DATA_LENGTH+INDEX_LENGTH)/1024/1024/1024,2) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$ErpDatabase';"
$total = Consultar $q2
Write-Host "  tabelas / GB:  $total"
$total | Out-File "$SaidaDir\total-$stamp.tsv" -Encoding utf8

Write-Host ''
Write-Host '== 3. Engines em uso (decide a estrategia do dump) ==' -ForegroundColor Cyan
$q3 = "SELECT ENGINE, COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$ErpDatabase' AND ENGINE IS NOT NULL GROUP BY ENGINE;"
$engines = Consultar $q3
$engines | ForEach-Object { Write-Host "  $_" }
$engines | Out-File "$SaidaDir\engines-$stamp.tsv" -Encoding utf8

if ("$engines" -match 'MyISAM') {
  Write-Host ''
  Write-Host '!! ATENCAO: existe tabela MyISAM.' -ForegroundColor Yellow
  Write-Host '   MyISAM nao tem transacao, entao --single-transaction NAO garante'
  Write-Host '   foto consistente. O dump precisa de --lock-all-tables, e enquanto'
  Write-Host '   ele roda NINGUEM escreve: a operacao para durante o dump.'
  Write-Host '   Use: .\02-dump.ps1 -Estrategia myisam'
} else {
  Write-Host ''
  Write-Host 'OK: so InnoDB. O dump roda sem travar - a loja opera normalmente.' -ForegroundColor Green
}

Write-Host ''
Write-Host '== 4. Contagem REAL das tabelas criticas ==' -ForegroundColor Cyan
Write-Host '   (TABLE_ROWS do information_schema e ESTIMATIVA no InnoDB;'
Write-Host '    conferir migracao com estimativa e o mesmo que nao conferir)'
$arqContagem = "$SaidaDir\contagens-$stamp.tsv"
foreach ($t in @('produtos', 'estoque', 'caixa', 'movimento', 'clientes', 'codigos', 'funcionarios')) {
  $existe = Consultar "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$ErpDatabase' AND TABLE_NAME='$t';"
  if ("$existe".Trim() -eq '1') {
    $n = Consultar "SELECT COUNT(*) FROM ``$t``;"
    $linha = "$t`t$("$n".Trim())"
    Write-Host "  $linha"
    $linha | Out-File $arqContagem -Encoding utf8 -Append
  }
}

Write-Host ''
Write-Host "Inventario salvo em $SaidaDir" -ForegroundColor Green
Write-Host 'Guarde o arquivo contagens-*.tsv: e com ele que o 04-verificar.ps1'
Write-Host 'confere se o restore trouxe tudo.'
