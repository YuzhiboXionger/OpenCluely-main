<div align="center">

# OpenCluely

**隐形的 AI 刷题面试助手。**

实时 AI 辅助，浮层对屏幕共享不可见。用语音、截图或聊天提问，答案边生成边呈现。

<p>
  <a href="https://github.com/TechyCSR/OpenCluely/releases/latest"><img src="https://img.shields.io/github/v/release/TechyCSR/OpenCluely?style=for-the-badge&label=Latest&color=111111&labelColor=000000" alt="最新版本" /></a>
  <a href="https://github.com/TechyCSR/OpenCluely/releases"><img src="https://img.shields.io/github/downloads/TechyCSR/OpenCluely/total?style=for-the-badge&color=111111&labelColor=000000" alt="下载量" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-111111?style=for-the-badge&labelColor=000000" alt="MIT 许可证" /></a>
  <img src="https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux-111111?style=for-the-badge&labelColor=000000" alt="支持平台" />
</p>

<a href="https://opencluely.techycsr.dev"><b>官方网站</b></a> &nbsp;|&nbsp;
<a href="#下载">下载</a> &nbsp;|&nbsp;
<a href="#快速开始">快速开始</a> &nbsp;|&nbsp;
<a href="#使用方式">使用方式</a> &nbsp;|&nbsp;
<a href="#项目结构">项目结构</a>

</div>

> 原作者仓库：[https://github.com/TechyCSR/OpenCluely](https://github.com/TechyCSR/OpenCluely)

## 演示

https://github.com/user-attachments/assets/896a7140-1e85-405d-bfbe-e05c9f3a816b

## 这是什么

OpenCluely 是一款基于 Electron 的桌面应用，面向技术面试与刷题练习。它在屏幕上放置一个可拖拽的 **命令栏** 和 **答题框（悬浮窗）**，两者默认绑定并始终置顶；在 Windows 与 macOS 上，它们还会被排除在录屏与会议共享之外。你可以截图、说话或在聊天窗里输入问题，DeepSeek 会流式生成答案，并按所选编程语言输出可复制的代码。

本项目基于原作者 [TechyCSR](https://github.com/TechyCSR) 的开源项目 [OpenCluely](https://github.com/TechyCSR/OpenCluely) 进行二次开发，主要改动包括：把模型后端切换为 DeepSeek（含失败自动降级）、截图改为「先视觉转写题目、再脱离历史作答」的两段式流程，并补充了中文文档与配置说明。原有架构与界面设计均来自原作者项目。

所有处理都在本机完成（语音识别与模型推理除外），应用不含遥测。唯一离开设备的，是你发往 DeepSeek 与（可选的）豆包语音服务的请求。

## 核心特性

- **隐身浮层。** 通过 Electron `setContentProtection`（Windows `WDA_EXCLUDEFROMCAPTURE`、macOS `NSWindowSharingNone`）让窗口不出现在 Zoom、Google Meet、Teams、Discord、OBS 的录制中；同时跳过任务栏、跨工作区置顶。
- **伪装模式。** 可将应用图标与进程名切换为「终端」「活动监视器」「系统设置」，在任务管理器中不易被察觉。
- **两段式截图解题。** 截图先由视觉模型逐字 **转写题目**，再基于转写文本作答；作答阶段不携带历史会话，避免上一题干扰本题。转写与解答都在答题框中流式呈现。
- **区域截图。** 用两次点击标记左上角、两次点击标记右下角，即可只识别选中的屏幕区域；支持多显示器。
- **可调答题框。** 快捷键调整宽度/高度/透明度，整体拖动或移动内容；答题框与命令栏绑定，可设置两者间距。
- **流式聊天。** 内置聊天窗支持 Markdown、代码块语法高亮、基础 LaTeX 公式渲染（上下标与常用符号），并实时显示语音识别的中间结果；代码块可在答题框中一键复制。
- **本地语音输入（可选）。** 豆包流式语音识别 2.0，16kHz PCM 实时上传，支持二遍识别；可选择麦克风或系统回环音频（Windows）。
- **可路由的回答。** 语音触发的回答可按设置只进聊天窗、只进答题框，或同时进入两者。
- **语言感知。** 针对 C++、C、Python、Java、JavaScript、Go、Dart 定制提示词：解释用简体中文，代码只用所选语言、无注释，并给出复杂度。
- **会话记忆。** 完整对话保存在进程内存中，追问、边界情况与优化建议都保留上下文；重启应用后清空。
- **首次启动向导。** 自动创建 `.env`，引导填写 DeepSeek 密钥，并可选配置语音识别。

## 下载

安装包随每次 Release 自动构建并附带 SHA-256 校验和，以下链接始终指向最新版本。

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `OpenCluely-Setup-<version>.exe` | NSIS 安装程序，可选安装目录，创建开始菜单与桌面快捷方式。 |
| Linux（Debian / Ubuntu） | `opencluely_<version>_amd64.deb` | 自动拉取 GTK、NSS、ALSA 等系统依赖。 |
| Linux（通用） | `*.AppImage` | 免安装，`chmod +x` 后直接运行。 |

> **macOS：** 不发布预编译包。应用未签名也未公证，Gatekeeper 会以“已损坏，无法打开”拦截下载版本，请从源码运行（见[快速开始](#快速开始)）。仓库内的 `build:mac` 可以在本机自签构建 `.dmg` / `.zip`。

网站 [opencluely.techycsr.dev](https://opencluely.techycsr.dev) 会自动识别操作系统并给出对应安装包。

## 快速开始

1. 克隆仓库并要求 Node.js 18+。

   ```bash
   git clone https://github.com/TechyCSR/OpenCluely.git
   cd OpenCluely
   ```

2. 运行安装脚本。

   ```bash
   ./setup.sh
   ```

   脚本会自动创建 `.env`、安装依赖，然后启动应用。

3. 在首次启动向导中填入 **DeepSeek API 密钥**。

   密钥可从 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 获取（也可直接写入 `.env`，保存后立即生效，无需重启）。语音识别为可选项，可以跳过，之后随时在设置中补填。

### 平台说明

- Windows 上请使用 Git Bash（随 Git for Windows 安装）或 WSL 运行 `setup.sh`；也可以直接用 `npm install && npm start`。
- macOS 与 Linux 使用普通终端即可。
- **macOS 必须从源码运行**：没有预编译的 `.dmg`，因为它们会被 Gatekeeper 拦截。
- 依赖由脚本处理，无需手动执行 `npm` 命令。

### 安装脚本选项

```bash
./setup.sh --build                # 为当前系统构建可分发包
./setup.sh --ci                   # 使用 npm ci 代替 npm install
./setup.sh --no-run               # 仅安装配置，不启动应用
DEEPSEEK_API_KEY=sk-... ./setup.sh  # 直接把密钥写入 .env
```

## 配置

配置来自项目根目录的 `.env`（由 `env.example` 生成）。唯一必填项是 DeepSeek 密钥。

```bash
# 必填：DeepSeek API 密钥
DEEPSEEK_API_KEY=your_deepseek_api_key_here

# 可选：覆盖模型与接口地址
# DEEPSEEK_MODEL=deepseek-flash
# DEEPSEEK_BASE_URL=https://api.deepseek.com

# 语音触发的回答显示位置：chat / overlay / both
SPEECH_RESPONSE_TARGET=both

# 音频输入源：microphone（麦克风）/ system（系统回环，Windows）
AUDIO_INPUT_SOURCE=microphone

# 可选：豆包流式语音识别（任选一种鉴权方式）
DOUBAO_API_KEY=
DOUBAO_APP_ID=
DOUBAO_ACCESS_TOKEN=
DOUBAO_RESOURCE_ID=volc.seedasr.sauc.duration
# 二遍识别：准确率更高，句尾延迟略增
DOUBAO_ENABLE_NONSTREAM=true

# 答题框与聊天窗背景透明度（0–100）
ANSWER_OPACITY=40
```

- 默认模型为 `deepseek-flash`，不可用时自动切换到 `deepseek-v4-pro`（均可用 `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` 覆盖）。
- 如果未配置豆包凭据，语音服务会保持禁用，麦克风按钮在全应用中隐藏。
- 设置窗口里填写的密钥、语音凭据与透明度会写回 `.env`，重启后仍然保留。

## 语音配置（可选）

语音识别使用豆包（火山引擎）流式语音识别。

1. 在[火山引擎控制台](https://console.volcengine.com/)开通流式语音识别服务。
2. 在设置 → 语音识别中填写 `DOUBAO_API_KEY`，或旧版控制台的 `APP ID` + `Access Token`。
3. 资源 ID 需与开通的服务一致：
   - `volc.seedasr.sauc.duration`：流式语音识别 2.0 小时版（推荐）
   - `volc.seedasr.sauc.concurrent`：流式语音识别 2.0 并发版
   - `volc.bigasr.sauc.duration` / `volc.bigasr.sauc.concurrent`：1.0 小时版 / 并发版

戴耳机参加会议时，把 **音频输入源** 切换为 **系统音频（会议声音）**，应用会采集系统回环音频，面试官的声音即使没进麦克风也能被转写。该能力目前仅在 **Windows** 上可用；macOS/Linux 上只能使用麦克风。

> 豆包语音在云端识别，需要联网，音频会上传至火山引擎。对隐私敏感时请不要启用语音。

## 使用方式

### 命令栏

屏幕上的小命令栏包含：截图按钮（`⌘⇧S` 提示）、麦克风开关、技能指示（当前为 DSA）、编程语言选择器、快捷键说明与交互状态指示灯。

- **拖动**：直接拖拽命令栏即可移动，答题框会跟随。
- **鼠标穿透**：按 `Ctrl/Cmd + .` 或 `Alt + A` 切换；穿透时点击会落到下层窗口。
- **显示/隐藏**：`Ctrl/Cmd + Shift + V` 一键隐藏所有窗口。

### 截图解题

- `Ctrl/Cmd + Shift + S` 或 `Ctrl/Cmd + H`：截取当前屏幕并分析。
- `Ctrl/Cmd + Alt + T`：区域截图。按提示点击两次左上角、再点击两次右下角（`Esc` 取消），只分析选中区域。

流程为两段式：先转写截图中的题目原文，再基于转写作答。结果会同时流式输出到答题框与聊天窗，答题框在内容包含代码时自动分为「文字说明 / 代码」两栏，并支持一键复制代码。

### 聊天窗

`Ctrl/Cmd + Shift + C` 打开。可直接输入问题（`Shift + Enter` 换行），回答同样以流式呈现；语音识别的中间文本会浮现在聊天区上方。清空聊天记录可使用窗口内的清空按钮。

### 语音输入

点击麦克风按钮或按 `Ctrl/Cmd + T` 开始/停止。识别分句在服务端完成，中间结果实时显示，停止后会等待最后一段结果再提交给模型。语音回答按 `SPEECH_RESPONSE_TARGET` 输出到聊天窗、答题框或两者。

## 键盘快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl/Cmd + Shift + S` | 截图并分析 |
| `Ctrl/Cmd + H` | 搜题（截图识别） |
| `Ctrl/Cmd + Alt + T` | 区域截图（两击左上角，两击右下角，`Esc` 取消） |
| `Ctrl/Cmd + T` | 开始 / 停止语音识别 |
| `Ctrl/Cmd + Tab` | 循环切换编程语言（C++ → C → Python → Java → JavaScript → Go → Dart） |
| `Ctrl/Cmd + Shift + V` | 显示 / 隐藏所有窗口 |
| `Ctrl/Cmd + .` 或 `Alt + A` | 切换交互模式（鼠标穿透） |
| `Ctrl/Cmd + Shift + C` | 打开聊天窗 |
| `Ctrl/Cmd + ,` | 打开设置 |
| `Ctrl/Cmd + ↑ / ↓ / ← / →` | 移动命令栏与答题框 |
| `Ctrl/Cmd + Shift + ↑ / ↓ / ← / →` | 移动答题框内容 |
| `Ctrl/Cmd + Shift + 1 / 2` | 减淡 / 加深答题框颜色（步进 10%） |
| `Ctrl/Cmd + Shift + 3 / 4` | 缩小 / 放大答题框宽度 |
| `Ctrl/Cmd + Shift + 5 / 6` | 缩小 / 放大答题框高度 |
| `Ctrl/Cmd + Shift + \` | 清空会话记忆 |
| `Ctrl/Cmd + R` | 清空会话并关闭答题区 |
| `Ctrl/Cmd + Shift + T` | 强制将全部窗口置顶 |
| `Ctrl/Cmd + Q` | 退出应用 |

## 设置项

| 分区 | 项目 | 说明 |
|---|---|---|
| 语言与技能 | 编程语言 | C++ / C / Python / Java / JavaScript / Go / Dart，DSA 提示词会注入该语言约束 |
| 语言与技能 | 当前技能 | 目前提供「数据结构与算法」（`prompts/dsa.md`） |
| 应用图标 | 终端 / 活动 / 设置 | 同时修改图标与进程名，用于伪装 |
| 语音识别 | 音频输入源 | 麦克风，或系统音频（会议声音，仅 Windows 回环） |
| 语音识别 | 语音回答目标 | 聊天窗和悬浮窗 / 仅聊天窗 / 仅悬浮窗 |
| 语音识别 | 豆包凭据 | API Key，或 APP ID + Access Token，加资源 ID、二遍识别开关 |
| DeepSeek | API 密钥 | 模型调用凭据，写回 `.env` |
| 窗口 | 窗口间距 | 命令栏与答题框的绑定间距（像素） |
| 窗口 | 回答透明度 | 答题框与聊天窗背景不透明度（0–100%） |

## 工作原理

1. **提问。** 截图（全屏 / 区域）、语音（麦克风 / 系统回环）或在聊天窗输入文字。
2. **转写（仅截图）。** 视觉模型以低温度逐字转写题目，无法辨认处标记 `[无法看清]`，不猜测。
3. **推理。** DeepSeek 结合所选技能与语言约束生成答案；语音与聊天请求会携带会话记忆，截图作答不携带历史。
4. **呈现。** 回答以 SSE 流式返回，经 IPC 广播到答题框与聊天窗，Markdown、代码高亮与公式即时渲染。

## 项目结构

```text
.
├── main.js                     # 主进程：窗口、快捷键、IPC、截图/语音/会话编排
├── preload.js                  # 渲染进程安全桥接（contextIsolation）
├── index.html                  # 命令栏浮层
├── llm-response.html           # 答题框（文字/代码双栏、流式、复制、透明度）
├── chat.html                   # 聊天窗（流式、Markdown、语音中间结果）
├── settings.html               # 设置面板
├── onboarding.html / .js       # 首次启动向导
├── region-select.html          # 区域截图点选层
├── prompt-loader.js            # 技能提示词加载与语言注入
├── prompts/
│   ├── dsa.md                  # 数据结构与算法技能提示词
│   └── programming.md
├── src/
│   ├── core/                   # 配置、首次运行、日志（winston，写入 ~/.OpenCluely/logs）
│   ├── managers/               # 会话记忆、窗口管理/绑定/隐身
│   ├── services/               # 截图、DeepSeek LLM、豆包语音识别
│   ├── ui/                     # 命令栏 / 聊天窗 / 设置窗渲染逻辑
│   └── styles/                 # 公共样式
├── lib/                        # Markdown 渲染与公式转换
├── webapp/                     # 官网静态页面（opencluely.techycsr.dev）
├── scripts/                    # 安装/打包辅助脚本
├── setup.sh                    # 一键安装并启动
├── env.example                 # 环境变量模板
└── assests/                    # 图标、截图、Font Awesome 资源
```

运行时数据（日志）位于 `~/.OpenCluely/logs`，按天轮转并按 `error-` / `application-` 分文件。

## 项目状态

OpenCluely 处于活跃开发阶段，核心功能可用。

### 已完成

- 可拖拽命令栏 + 绑定跟随的答题框，支持置顶、跳过任务栏、跨工作区可见
- Windows / macOS 屏幕捕获排除（Linux 暂不支持，见下方限制）
- 应用图标与进程名伪装（终端 / 活动监视器 / 系统设置）
- 全屏与区域截图（多点选区域、多显示器）
- 两段式截图解题：视觉转写 + 无历史作答，流式输出
- DeepSeek 流式对话，主模型失败时自动切换备用模型
- 豆包流式语音识别，中间结果实时显示，支持麦克风与 Windows 系统回环
- 语音回答路由、句尾等待、断线重连
- 答题框文字/代码双栏、代码复制、透明度与尺寸快捷键
- 聊天窗：Markdown、代码高亮、公式渲染、流式气泡
- DSA 技能提示词与五语言代码约束
- 会话记忆（内存）与一键清空
- 首次启动向导与 `.env` 自动写回
- 日志轮转与有多显示器支持的窗口管理

### 计划中

- 自动检测屏幕共享并隐藏窗口（相关窗口管理能力已具备，尚未接入界面）
- 在 DeepSeek 之外支持更多模型后端（OpenAI、Anthropic、本地模型）
- 将代码片段自动输入编辑器 / IDE
- 会话历史导出为 Markdown 或 PDF
- 更深层的进程伪装（进程名随机化）

## 故障排查

<details>
<summary>安装问题</summary>

- **`setup.sh` 无法运行。** 确认位于项目目录（`cd OpenCluely`），并赋予执行权限（`chmod +x setup.sh`）。Windows 请使用 Git Bash。
- **安装以退出码 130 结束。** 表示按下了 Ctrl+C，重新运行即可。
- **提示找不到 Node / npm。** 安装 Node.js 18 或更高版本，重启终端后重试。
- **`npm start` 报 Electron 相关错误。** 可尝试 `npm run dev`（带 `--no-sandbox --disable-gpu`）。

</details>

<details>
<summary>应用问题</summary>

- **首次启动不弹向导。** 删除项目根目录的 `.opencluely-firstrun-completed` 与 `.env` 后重启；或直接按 `Ctrl/Cmd + ,` 打开设置填写密钥。
- **提示模型不可用。** 检查 `DEEPSEEK_API_KEY` 是否有效，`DEEPSEEK_MODEL` 是否为平台支持的模型名；日志见 `~/.OpenCluely/logs`。
- **macOS 截图空白。** 在“系统设置 → 隐私与安全性 → 屏幕录制”中授权后重启应用。
- **Linux 无法启动或窗口空白。** 使用 `npm run dev`，并确保 X11 / XWayland 可用。
- **Windows SmartScreen 拦截。** 点击“更多信息 → 仍要运行”，或开发时使用 `npm start`。
- **麦克风按钮消失。** 说明未配置豆包凭据；语音是可选项。
- **系统音频没有声音。** 该选项仅在 Windows 生效，且需要系统正在播放声音；若会议软件使用独占模式可能采集不到。

</details>

<details>
<summary>限制</summary>

- **Linux 上无法对屏幕共享隐身。** 浮层隐藏依赖 Electron 的 `setContentProtection`：macOS 映射为 `NSWindowSharingNone`，Windows 映射为 `WDA_EXCLUDEFROMCAPTURE`。Electron 在 Linux（X11 与 Wayland）上没有任何等价实现，调用会被静默忽略，浮层**会**出现在共享画面中。变通方案：只共享单个应用窗口，或把浮层放到未共享的显示器上。
- **系统回环音频仅 Windows。** macOS / Linux 只能使用麦克风输入。
- **会话记忆不落盘。** 记忆保存在进程内存，退出或清空后不可恢复。
- **语音依赖云端。** 豆包在云端识别，需要联网并上传音频。

</details>

## 隐私与安全

- 无遥测、无统计、无账号体系。会话内容只保留在内存与本地日志中。
- 密钥保存在本地 `.env`（首次创建时尽力设置为 `0600`），请求直连 DeepSeek / 火山引擎，不经过任何中转服务器。
- 语音可选：不配置豆包凭据时，不会采集或上传任何音频。
- 应用面向学习与练习。请遵守你参加的面试规则与相关公司的政策。

## 许可证

基于 MIT 许可证发布，详见 [LICENSE](LICENSE)。

## 致谢

- DeepSeek 提供模型推理与截图视觉转写
- 豆包（火山引擎）提供可选的流式语音识别
- Electron 提供跨平台桌面运行时
- marked、PrismJS、Font Awesome 提供渲染与图标能力
- [Vysper by varun-singhh](https://github.com/varun-singhh/Vysper) 提供界面与结构灵感

<div align="center">

由 [TechyCSR](https://techycsr.dev) 构建。如果 OpenCluely 对你有帮助，欢迎点个星 ⭐

</div>
