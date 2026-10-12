$ErrorActionPreference = 'Stop'

$codexSkills = 'C:\Users\33054\.codex\skills'
if (Test-Path -LiteralPath $codexSkills) {
  Get-ChildItem -LiteralPath $codexSkills -Force -Directory | Where-Object { $_.Name -ne '.system' } | Remove-Item -Recurse -Force
}

$agentsSkills = 'C:\Users\33054\.agents\skills'
if (Test-Path -LiteralPath $agentsSkills) { Remove-Item -LiteralPath $agentsSkills -Recurse -Force }

$claudeSkillTarget = 'C:\Users\33054\skills'
if (Test-Path -LiteralPath $claudeSkillTarget) {
  Get-ChildItem -LiteralPath $claudeSkillTarget -Force | Remove-Item -Recurse -Force
}

$codexPersonal = 'C:\Users\33054\.codex\plugins\cache\personal'
if (Test-Path -LiteralPath $codexPersonal) { Remove-Item -LiteralPath $codexPersonal -Recurse -Force }

$claudeRepos = 'C:\Users\33054\.claude\skills-repos'
if (Test-Path -LiteralPath $claudeRepos) { Remove-Item -LiteralPath $claudeRepos -Recurse -Force }

$claudePluginCache = 'C:\Users\33054\.claude\plugins\cache\comeonzhj-Auto-Redbook-Skills'
if (Test-Path -LiteralPath $claudePluginCache) { Remove-Item -LiteralPath $claudePluginCache -Recurse -Force }

$claudeMarketplace = 'C:\Users\33054\.claude\plugins\marketplaces\comeonzhj-Auto-Redbook-Skills'
if (Test-Path -LiteralPath $claudeMarketplace) { Remove-Item -LiteralPath $claudeMarketplace -Recurse -Force }

$installedPath = 'C:\Users\33054\.claude\plugins\installed_plugins.json'
if (Test-Path -LiteralPath $installedPath) {
  $installed = Get-Content -Raw -LiteralPath $installedPath | ConvertFrom-Json
  if ($installed.plugins.PSObject.Properties.Name -contains 'auto-redbook-skills@comeonzhj-Auto-Redbook-Skills') {
    $installed.plugins.PSObject.Properties.Remove('auto-redbook-skills@comeonzhj-Auto-Redbook-Skills')
  }
  $installed | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $installedPath -Encoding utf8
}

$marketplacesPath = 'C:\Users\33054\.claude\plugins\known_marketplaces.json'
if (Test-Path -LiteralPath $marketplacesPath) {
  $marketplaces = Get-Content -Raw -LiteralPath $marketplacesPath | ConvertFrom-Json
  if ($marketplaces.PSObject.Properties.Name -contains 'comeonzhj-Auto-Redbook-Skills') {
    $marketplaces.PSObject.Properties.Remove('comeonzhj-Auto-Redbook-Skills')
  }
  $marketplaces | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $marketplacesPath -Encoding utf8
}

Write-Output 'DELETION_COMPLETE'
