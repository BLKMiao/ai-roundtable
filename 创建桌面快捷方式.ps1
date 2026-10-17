# Creates "黑喵船长 AI圆桌.lnk" (desktop by default) that starts the app without a console window, with the new icon.
param([string]$Folder = [Environment]::GetFolderPath('Desktop'))
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @("$env:LOCALAPPDATA\Programs\Python\Python313\pythonw.exe")
$py = (Get-Command pyw.exe -ErrorAction SilentlyContinue)
$pythonw = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pythonw) {
  $found = (& py -3.13 -c "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))" 2>$null)
  if ($found -and (Test-Path $found)) { $pythonw = $found }
}
if (-not $pythonw) { Write-Host '没有找到 Python 3.13。请先安装 64 位 Python 3.13。'; exit 1 }
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $Folder '黑喵船长 AI圆桌.lnk'))
$link.TargetPath = $pythonw
$link.Arguments = '"' + (Join-Path $root 'app.py') + '"'
$link.WorkingDirectory = $root
$link.IconLocation = (Join-Path $root 'roundtable-robot.ico') + ',0'
$link.Description = '黑喵船长 AI圆桌'
$link.Save()
Write-Host ('已创建快捷方式：' + (Join-Path $Folder '黑喵船长 AI圆桌.lnk'))
