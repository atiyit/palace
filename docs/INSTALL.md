# 安装与启动

主人，请先把完整源码解压到自己有写入权限的文件夹。中文和空格路径可以使用；不要直接在 ZIP 预览窗口内启动，也不要放在系统的只读安装目录。

## 第一次使用

| 平台 | 入口 |
| --- | --- |
| Windows x64 / ARM64 | 双击根目录的 `一键安装并启动.cmd`。原有 `启动后宫.cmd` 也使用同一套逻辑。 |
| macOS Intel / Apple Silicon | 在项目目录执行 `sh './一键安装并启动.command'`。给予执行权限后，也可双击 `.command` 文件。 |
| Linux x64 / ARM64，glibc | 在项目目录执行 `sh './一键安装并启动.sh'`。图形桌面是否支持双击脚本，由文件管理器设置决定。 |

安装器会查找主人系统中已有的 Node.js 24 或更高版本及 npm；找到时优先使用，不重复下载。找不到可用组合时，安装器从 [Node.js 官方下载站](https://nodejs.org/en/download) 查询 Node 24 发布线（latest-v24.x）的当前版本，通过 HTTPS 下载对应系统与架构的运行时，并以同样通过 HTTPS 获取的官方 `SHASUMS256.txt` 验证 SHA-256 校验和后，保存在项目的 `.palace-runtime/node/`。这里校验的是 HTTPS 传输获取的官方校验和，没有额外进行 GPG 签名密钥验证。

接着运行锁定版本的 `npm ci`，安装应用所需的普通、开发和可选依赖。完成后启动本机后台服务并打开 **http://127.0.0.1:5173/**。关闭浏览器不会停止后台服务。

安装过程中不会修改系统 PATH，不需要管理员或 `sudo`，也不会更改主人已有的角色、聊天和记忆数据。安装器不会自动下载或安装任何 AI 大语言模型。

> **首次存档说明**
>
> 首次启动时，默认存档包含 8 位未录用的示例角色供主人体验。如果主人在应用内清空了存档，这些示例不会被自动重新创建。
>
> 想重新体验示例时：先停止应用，完整备份当前的数据目录（默认 `.palace-data/`），然后将该数据目录改名（例如改为 `.palace-data-backup/`），再使用新的默认目录启动即可。原存档不会自动迁回新目录，请主人自行管理备份。

macOS 的 ZIP 解压工具可能不保留脚本执行权限。需要双击入口时，先在项目目录执行一次：

```sh
chmod +x './一键安装并启动.command' './停止后宫.command'
```

系统可能另外要求主人通过文件的“打开”菜单确认来源。终端的 `sh` 入口不依赖脚本执行位；不必关闭系统安全设置。Linux 的 `.sh` 文件同样可以使用 `chmod +x` 后直接执行。

## 环境要求与支持边界

- Windows 需要 PowerShell 5.1 或更高版本；macOS / Linux 需要 `sh`、`curl`、`tar`，以及 `sha256sum` 或 `shasum`。这类基础系统工具不由安装器管理。
- 自动下载覆盖 Windows、macOS、glibc Linux 的 x64 / ARM64。32 位系统、其他处理器架构、musl/Alpine、Android 和特殊发行版不在自动安装范围；主人已自行安装的兼容 Node.js 24+ 与 npm 可被复用，但不能据此保证所有依赖在该环境兼容。
- 系统版本本身还需符合 [Node 24 的平台要求](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list)。较旧的 macOS、Windows、Linux 内核或 glibc 可能无法运行官方二进制。
- 首次安装需要访问 `nodejs.org` 和 npm 仓库。安装包不是离线包；没有绑定或自动下载大语言模型。使用本地 AI 时，还需主人自行启动 Ollama、LM Studio 或兼容服务。
- Node 和依赖优先使用官方预编译包；特殊环境若需要从源码编译原生依赖，应按 npm 报错补齐系统编译工具。安装器不会自动安装系统级编译器。
- **Windows 已在隔离目录完成实际验证**，包括官方 Node 24 下载与校验、全部依赖安装、doctor 检查、启动和构建。仓库的 [GitHub Actions](https://github.com/atiyit/palace/actions/workflows/ci.yml) 在 Windows、macOS、Linux 环境执行安装、测试和构建，主人可查看每次运行的实际结果。验证范围是对应的运行环境，不代表所有系统版本和架构；测试数量和 Node patch 版本会随迭代变化。

## 再次启动与停止

再次运行相同入口即可。依赖指纹包含 `package.json`、`package-lock.json`、`.npmrc`、平台、架构及 Node 版本；匹配且依赖检查通过时，直接复用已安装内容。已有受启动器管理的进程也会复用，避免重复启动。

停止时使用相应入口：

| 平台 | 停止方式 |
| --- | --- |
| Windows | 双击 `停止后宫.cmd` |
| macOS | 双击 `停止后宫.command`，或 `sh './停止后宫.command'` |
| Linux | `sh './停止后宫.sh'` |
| 已有 Node / npm | `npm run local:stop` |

停止功能核对项目路径和本次进程的随机标识，不会仅凭端口号结束其他程序。Windows 旧版启动器记录的进程，仍可通过 `停止后宫.cmd` 停止。用 `npm start` 直接前台启动的服务请在原终端按 `Ctrl+C`；它不受后台启动器管理。

## 常用参数

Windows `.cmd` 入口可透传参数到 PowerShell 脚本。在 PowerShell 终端也可直接运行：

```powershell
.\scripts\bootstrap.ps1 -InstallOnly
.\scripts\bootstrap.ps1 -Repair -NoBrowser
.\scripts\bootstrap.ps1 -PrivateRuntime -InstallOnly
```

如果终端的执行策略不允许直接运行脚本，可使用根目录入口，例如在 PowerShell 中：`& '.\一键安装并启动.cmd' -InstallOnly`。这个入口仅为本次脚本进程设置执行策略，不更改系统的永久配置。

macOS / Linux：

```sh
sh scripts/bootstrap.sh --install-only
sh scripts/bootstrap.sh --repair --no-browser
sh scripts/bootstrap.sh --private-runtime --install-only
```

| 参数 | 作用 |
| --- | --- |
| `-InstallOnly` / `--install-only` | 只准备运行环境和依赖，不启动服务。 |
| `-Repair` / `--repair` | 重新运行 `npm ci`；用于依赖损坏。它重建 `node_modules`，不清理存档。 |
| `-NoBrowser` / `--no-browser` | 启动后台服务，但不自动打开浏览器。 |
| `-PrivateRuntime` / `--private-runtime` | 优先使用项目内的 Node 24 运行时；没有时下载。它不是每次联网更新的开关。 |

已有 Node.js 24+ 与 npm 时，也可执行 `npm run setup` 只安装依赖、`npm run local:open` 安装并打开后台服务。经典的 `npm ci` 与 `npm start` 前台方式仍然可用。`npm run build` 只构建前端，不能把输出目录单独当作完整应用运行。

## 端口、日志与存档

默认使用 5173 端口。若被其他程序或另一份 Palace 占用，主人可以停止对应程序，或指定新端口：

```powershell
$env:PALACE_PORT = '5180'
& '.\一键安装并启动.cmd'
```

```sh
PALACE_PORT=5180 sh './一键安装并启动.sh'
# macOS 也可使用：PALACE_PORT=5180 sh './一键安装并启动.command'
```

仍然只监听 `127.0.0.1`。改变端口不会使服务对外公开。一个项目已有后台进程时，先停止它，再更换端口。

| 路径 | 内容 |
| --- | --- |
| `.palace-data/` | 默认存档、上传与生成内容、密钥保管库；不要公开上传。 |
| `.palace-runtime/node/` | 自动下载的项目内 Node 与 npm。 |
| `.palace-runtime/npm-cache/` | 当前项目的依赖下载缓存。 |
| `.palace-runtime/dependencies.json` | 依赖指纹。 |
| `.palace-runtime/server.log` | 后台启动与运行日志。 |
| `.palace-runtime/server-session.json` | 该项目后台进程的身份记录。 |

高级使用可通过 `PALACE_DATA_DIR` 指定存档目录。日常使用无需设置。备份时请先停止应用，再完整备份 `.palace-data/`，尤其保留 `vault.key`；密钥保管库需要它读取已加密的 API Key。

## 出错时

- **下载中断或校验不一致：** 入口会显示错误，停止执行未校验的下载内容。恢复网络后重新运行；失败下载留在 `.palace-runtime/download-*`，不会被当成可用运行时。
- **npm 安装失败：** 保留并查看终端里的 npm 错误；检查网络、磁盘和 npm 源配置，然后重试。失败时不会写入“安装完成”指纹。
- **依赖损坏：** 先停止应用，再使用修复参数。更新源码、切换系统架构或 Node 版本后需要重装时，也应先停止旧进程。
- **提示安装或启动锁存在：** 先确认没有另一个安装窗口或启动进程。如果上次被强制中断，关闭残留进程后，重命名 `.palace-runtime/install-lock` 或 `.palace-runtime/startup-lock`，再重试。不要在另一安装仍在运行时移除锁。
- **浏览器没打开：** 手动打开终端输出的本机网址。无桌面的 Linux 可正常运行后台服务，但本机浏览器仍需可用。
- **服务退出：** 查看 `.palace-runtime/server.log`。新启动器与旧前台会话不会相互认领；先在旧终端停止服务，或更换 `PALACE_PORT`。

卸载时先停止服务。源码、`node_modules/` 和 `.palace-runtime/` 都在项目目录内；存档位于 `.palace-data/` 或主人指定的位置，是否保留请主人单独决定。安装器不会代主人删除这些存档。

[返回 README](../README.md) · [使用指南](GUIDE.md)
