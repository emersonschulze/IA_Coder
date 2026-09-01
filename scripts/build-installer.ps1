<#
.SYNOPSIS
  Gera o instalador Windows (.exe) do IA_Coder.

.DESCRIPTION
  Faz os três passos na ordem certa:
    1. apps/server  → npm install (o instalador leva o node_modules junto,
       inclusive o "tsx" — sem isso o servidor empacotado não sobe)
    2. apps/web     → npm install + build (gera apps/web/dist)
    3. apps/desktop → npm install + electron-builder (gera apps/desktop/release/*.exe)

.EXAMPLE
  .\scripts\build-installer.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'

Write-Host '[1/3] apps/server — instalando dependências…' -ForegroundColor Cyan
Push-Location (Join-Path $root 'apps/server')
npm install
Pop-Location

Write-Host '[2/3] apps/web — build de produção…' -ForegroundColor Cyan
Push-Location (Join-Path $root 'apps/web')
npm install
npm run build
Pop-Location

Write-Host '[3/3] apps/desktop — empacotando o instalador…' -ForegroundColor Cyan
Push-Location (Join-Path $root 'apps/desktop')
npm install
npm run dist
Pop-Location

$release = Join-Path $root 'apps/desktop/release'
Write-Host ''
Write-Host "Pronto. O instalador está em: $release" -ForegroundColor Green
Get-ChildItem $release -Filter '*.exe' | ForEach-Object { Write-Host " - $($_.Name)" }
