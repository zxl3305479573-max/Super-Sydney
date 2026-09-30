$ErrorActionPreference = 'Stop'
$vault = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
python (Join-Path $PSScriptRoot 'evolve.py') --vault $vault --watch
