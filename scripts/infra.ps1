<#
.SYNOPSIS
  Atalhos da infraestrutura do IA_Coder.

.EXAMPLE
  .\scripts\infra.ps1 up          # postgres + redis
  .\scripts\infra.ps1 up -Ai      # + Ollama (embeddings locais)
  .\scripts\infra.ps1 psql        # abre o psql no banco
  .\scripts\infra.ps1 reset       # APAGA os volumes e recria do zero
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'down', 'logs', 'ps', 'psql', 'redis', 'pull-model', 'reset')]
  [string]$Command = 'up',
  [switch]$Ai
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Host '.env criado a partir de .env.example — troque a senha do Postgres.' -ForegroundColor Yellow
}

$profiles = @()
if ($Ai) { $profiles += @('--profile', 'ai') }

switch ($Command) {
  'up' {
    docker compose @profiles up -d
    docker compose ps
  }
  'down'  { docker compose @profiles down }
  'logs'  { docker compose logs -f --tail=100 }
  'ps'    { docker compose ps }
  'psql'  { docker exec -it ia_coder_postgres psql -U iacoder -d iacoder }
  'redis' { docker exec -it ia_coder_redis redis-cli }
  'pull-model' {
    docker compose --profile ai up -d ollama
    docker exec -it ia_coder_ollama ollama pull nomic-embed-text
  }
  'reset' {
    Write-Host 'Isto apaga TODOS os dados do Postgres e do Redis.' -ForegroundColor Red
    if ((Read-Host 'Digite SIM para continuar') -ne 'SIM') { return }
    docker compose --profile ai down -v
    docker compose up -d
  }
}
