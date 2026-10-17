param(
 [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'BlkMiao\AI-Roundtable'),
 [string]$ShortcutDir = [Environment]::GetFolderPath('Desktop'),
 [switch]$InstallPython,
 [switch]$Launch
)
$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
function Find-Python {
 $paths = @((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'))
 if (Get-Command py.exe -ErrorAction SilentlyContinue) {
  $found = & py.exe -3.13 -c 'import sys;print(sys.executable)' 2>$null
  if ($LASTEXITCODE -eq 0) { $paths += $found }
 }
 foreach ($candidate in $paths) {
  if (Test-Path -LiteralPath $candidate) {
   & $candidate -c 'import sys,struct;sys.exit(0 if sys.version_info[:2]==(3,13) and struct.calcsize("P")==8 else 1)'
   if ($LASTEXITCODE -eq 0) { return $candidate }
  }
 }
 return $null
}
$python = Find-Python
if (-not $python -and $InstallPython) {
 if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'winget unavailable. Install Python 3.13 x64 from python.org.' }
 & winget.exe install --id Python.Python.3.13 --exact --source winget --scope user --architecture x64 --silent --accept-source-agreements --accept-package-agreements
 if ($LASTEXITCODE -ne 0) { throw 'Python installation failed.' }
 $python = Find-Python
}
if (-not $python) { throw 'Python 3.13 x64 required. Run with -InstallPython to install it via winget, or install from python.org.' }
$target = [IO.Path]::GetFullPath($InstallDir)
if (Test-Path -LiteralPath $target) { throw "Target already exists; nothing overwritten: $target" }
# Validate bundled native dependencies before copying. No pip / external API calls.
Push-Location $source
try {
 & $python -c 'import sys;sys.path.insert(0,"vendor");from PIL import Image;import pypdf;Image.new("RGB",(2,2)).tobytes();print("Dependencies OK")'
 if ($LASTEXITCODE -ne 0) { throw 'Bundled dependencies failed validation.' }
} finally { Pop-Location }
New-Item -ItemType Directory -Path $target -Force | Out-Null
Get-ChildItem -LiteralPath $source -Force | Where-Object { $_.Name -notin @('data','work','.git','__pycache__') } | ForEach-Object {
 Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse
}
$pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonw)) { throw 'pythonw.exe missing.' }
New-Item -ItemType Directory -Path $ShortcutDir -Force | Out-Null
$shortcut = Join-Path $ShortcutDir '黑喵船长 AI圆桌.lnk'
if (Test-Path -LiteralPath $shortcut) { throw "Shortcut already exists, not overwritten: $shortcut" }
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
$link.TargetPath = $pythonw
$link.Arguments = '"' + (Join-Path $target 'app.py') + '"'
$link.WorkingDirectory = $target
$link.IconLocation = (Join-Path $target 'roundtable-robot.ico') + ',0'
$link.Description = '黑喵船长 · AI圆桌'
$link.Save()
Write-Output "Installed: $target"
Write-Output "Shortcut: $shortcut"
if ($Launch) { Start-Process -FilePath $pythonw -ArgumentList ('"' + (Join-Path $target 'app.py') + '"') -WorkingDirectory $target -WindowStyle Hidden }
