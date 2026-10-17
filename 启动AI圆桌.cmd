@echo off
cd /d "%~dp0"
if exist "%LOCALAPPDATA%\Programs\Python\Python313\pythonw.exe" (
  start "" "%LOCALAPPDATA%\Programs\Python\Python313\pythonw.exe" "%~dp0app.py"
  exit /b
)
where pyw >nul 2>&1
if errorlevel 1 (
  echo Python 3.13 x64 is required. Please read the package instructions.
  pause
  exit /b 1
)
pyw -3.13 "%~dp0app.py"
