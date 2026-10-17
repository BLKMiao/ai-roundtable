@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo AI 圆桌演示模式：使用模拟回复，不需要密钥，不会产生费用，也不会改动你的真实聊天记录。
echo 关闭此窗口即可退出。
if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
  "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" tools\demo.py
) else (
  py -3.13 tools\demo.py
)
