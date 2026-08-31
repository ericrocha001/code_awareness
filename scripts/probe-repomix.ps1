$ErrorActionPreference = 'Continue'
$ErrorActionPreference = 'Continue'
$base = Get-ChildItem $env:TEMP -Directory -Filter 'repo_probe_*' | Select-Object -First 1 -ExpandProperty FullName
Write-Output "=== REPO: $base ==="

Write-Output "### TESTE C: SEM commit, apenas TS"
Set-Location $base
# cria arquivo novo untracked para garantir estado sem commit parcial
Set-Content -Path (Join-Path $base 'untracked.ts') -Encoding utf8 -Value 'export const u = 9'
npx repomix --include "normal.ts,untracked.ts" --style xml --stdout 2>$null | Select-String -Pattern '<file path' 

Write-Output "### TESTE D: SEM commit, com binarios no include"
npx repomix --include "normal.ts,image.png,document.pdf" --style xml --stdout 2>$null | Select-String -Pattern '<file path|ERROR|error' 

Write-Output "### TESTE E: SEM commit, binarios + --compress + flags de limpeza (cenario de producao)"
npx repomix --include "normal.ts,image.png,document.pdf,untracked.ts" --compress --remove-comments --remove-empty-lines --truncate-base64 --style xml --stdout 2>$null | Select-String -Pattern '<file path|ERROR|error'

Write-Output "### TESTE F: git-ignored via include explicito"
npx repomix --include "secret.ts" --style xml --stdout 2>$null | Select-String -Pattern '<file path'