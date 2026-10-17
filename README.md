# 黑喵船长 · AI 圆桌

> **使用前必读：需要自行接入 API。** 请准备自己的 API 服务地址、密钥和可用模型；API 费用由服务商收取，ChatGPT / Claude 订阅不等于 API 额度。

让 Claude、GPT、Gemini 在同一个工具里讨论、协同写作和整理分镜。由黑喵船长分享。

仓库：https://github.com/BLKMiao/ai-roundtable

下载完整 ZIP：https://github.com/BLKMiao/ai-roundtable/archive/refs/heads/main.zip

## 最简单的安装方法

Windows 10/11 x64：下载完整 ZIP、解压，然后双击 **安装.cmd**。安装器检测 Python 3.13 x64；缺少时通过 winget 安装 Python。成功后桌面出现 **黑喵船长 AI圆桌** 图标。

如果没有 winget，请从 Python 官网安装 Python 3.13 x64，再运行安装入口。当前不支持 macOS / Linux / Windows ARM 原生环境。

## 交给 AI 助手安装

把下面这段话和本仓库链接一起交给有本机文件及终端权限的 Codex、Claude Code、WorkBuddy 或其他助手：

> 请帮我安装这个仓库里的“黑喵船长 AI圆桌”。先阅读 README.md 和 INSTALL_FOR_AGENTS.md，检查 install.ps1，然后下载或解压完整项目，执行安装并创建桌面快捷方式。如果缺少 Python 3.13 x64，使用安装脚本的 -InstallPython 参数。保留我已有的安装和数据，不要读取或上传其他文件，不要替我填写或索要聊天中的 API 密钥。最后告诉我实际安装位置和运行结果。

不同助手是否能实际安装取决于其电脑操作和终端权限；纯聊天模式不能直接安装。

## 第一次打开

进入设置 → 连接，填写你自己的 API 服务、模型和密钥。内置模型 ID 是示例，需确认供应商支持后使用。API 调用可能产生供应商费用，工具不是免费模型额度。ChatGPT / Claude 聊天订阅不等于已配置 API。

## 文件与隐私

默认安装到 `%LOCALAPPDATA%/BlkMiao/AI-Roundtable`，记录与设置在安装目录 data 中；本地服务只监听 127.0.0.1。使用模型时，相关问题、历史及选择的资料会发送到所配置的 API 服务；主动读取网页会访问对应网址。安装入口不上传聊天或密钥、不改系统代理、不设开机自启。

安装器遇到已存在目录或快捷方式会停止，不自动覆盖。更新或卸载前请保留 data；它可能含个人对话和设置，请勿发到公开仓库。旧文档中的手动创建图标方式仅用于手动便携部署。

## 发布状态

本版本提供 Windows 源码安装包。已做本机安装验证，尚未覆盖所有助手或干净 Windows 系统。项目尚未指定开源许可证；公开可下载不等于授予任意再分发或商用许可，第三方许可保留在 vendor 和 assets 中。

