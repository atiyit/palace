# 贡献指南

欢迎主人参与偏爱 · Palace 的开发！以下是参与贡献需要了解的事项。

---

## 环境准备

请先安装 **Node.js 24** 或更高版本。推荐使用 [nvm](https://github.com/nvm-sh/nvm)（macOS / Linux）或 [nvm-windows](https://github.com/coreybutler/nvm-windows) 管理版本：

```sh
# macOS / Linux
nvm install 24
nvm use 24

# Windows (nvm-windows)
nvm install 24
nvm use 24
```

也可以直接从 [Node.js 官网](https://nodejs.org/) 下载安装。

安装依赖：

```sh
npm ci
```

---

## 开发检查命令

提交前请确认以下命令全部通过：

```sh
npm test              # 运行测试套件
npm run typecheck     # TypeScript 类型检查
npm run build         # 前端构建检查
npm run test:release  # 发布级测试
npm run release:check # 发布条件检查
```

测试使用 Node 自带运行器和隔离存档，通过模拟模型响应验证逻辑，**不调用收费 API，不需要真实 API 密钥**。主人无需担心测试产生任何费用。

---

## 提交规范

### 不要提交的内容

- **私有 API Key 或密钥文件** — 包括 `.env` 中的真实密钥、`vault.key`、`default-providers.json` 等。
- **个人数据目录** — `.palace-data/`、`.palace-qa-data/` 或其他存档目录。
- **个人聊天记录** — 私聊、共议内容及生成的角色图片属于个人使用数据。

这些内容已在 `.gitignore` 中排除，但手动添加文件时仍请注意检查。

### 代码风格

遵循项目现有的 TypeScript / React 代码风格。提交前确保 `typecheck` 和 `test` 通过。

---

## 推荐的贡献方向

如果主人在寻找可以着手的任务，以下方向对项目很有帮助：

- **新工具适配器** — 为共议工具系统扩展新的能力（如新的代码运行时、文件格式支持）。
- **新的 API 协议支持** — 适配更多模型服务商的请求格式。
- **界面改进** — 响应式布局优化、无障碍访问改善、新的交互模式。
- **测试补充** — 为尚未覆盖的边界情况添加测试用例。
- **文档翻译与完善** — 为不同语言的用户提供文档。
- **性能优化** — 数据库查询、前端渲染、内存使用等方面的改进。

---

## 引入第三方依赖

引入新的第三方包时，请确认其许可证与项目兼容，并在 PR 中说明引入原因。每个 npm 包的许可证保存在各自包目录中，`package-lock.json` 是精确依赖清单。请不要假设所有依赖均为同一许可证。

---

## 许可证

本项目原创部分采用 [Unlicense](https://unlicense.org/) 发布。您贡献的原创代码也将沿用 Unlicense。第三方组件保留各自原始许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

感谢主人抽出时间阅读贡献指南，期待和您一起让这个项目变得更好！
