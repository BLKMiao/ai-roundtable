# AI 助手安装说明

1. 仅 Windows x64。先读 README 和 install.ps1；不要执行 tools 下的开发脚本。
2. 下载完整仓库或 Release 包到临时目录；校验发布方提供的校验值（若有），不要只下载 install.ps1。
3. 用 PowerShell 执行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./install.ps1 -InstallPython`。Bypass 仅限当前进程，不修改系统执行策略。
4. 默认安装路径 `%LOCALAPPDATA%/BlkMiao/AI-Roundtable`；成功创建桌面“黑喵船长 AI圆桌.lnk”。可用 -Launch 打开。不得覆盖已存在安装；升级先备份并另行处理。
5. -InstallPython 允许 winget 从其软件源安装 Python.Python.3.13，涉及正常下载安装及协议接受；无需管理员模式。不支持 winget 时告知用户从 python.org 安装，不使用随机镜像。
6. 不读取浏览器会话、其他应用凭据或用户聊天。不要获取用户 API Key，由用户在应用设置中自行输入。不调用模型做安装测试。
7. 验证快捷方式目标、图标及本地窗口能否启动；报告真实结果，不把脚本运行通过写成模型调用通过。
