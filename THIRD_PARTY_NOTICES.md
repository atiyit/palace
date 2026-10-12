# 第三方声明与许可证

主人好，这份文档记录了项目中涉及的许可证与第三方资源信息。以下内容力求准确，请以实际附带的许可证文件为准。

---

## 项目原创部分

本项目的原创代码、原创文档和原创配置采用 [Unlicense](https://unlicense.org/) 发布。详见项目根目录的 `LICENSE` 文件。

---

## 第三方代码

### shadcn/ui 生态组件

- **文件：** `vendor/shadcn-tailwind-4.13.0.css`
- **来源：** [shadcn/ui](https://ui.shadcn.com/) 生态
- **许可证：** MIT License
- **版权：** Copyright (c) 2023 shadcn
- **许可证文件：** `vendor/shadcn-tailwind-4.13.0.LICENSE.md`

`components/ui/` 包含基于 shadcn/ui 生态的组件；适用部分遵循原许可证，保留已有声明。本项不将所有组件统一归为同一作者。

### sites-vite-plugin

- **文件：** `build/sites-vite-plugin.ts`（历史托管构建插件）
- **许可证：** MIT License
- **版权：** Copyright (c) 2026 OpenAI
- **许可证文件：** `build/sites-vite-plugin.LICENSE`

---

## npm 依赖

项目通过 npm 管理的依赖包各自包含独立的许可证文件，保存在各包的目录内（通常为 `node_modules/<package>/LICENSE`）。`package-lock.json` 是精确的依赖版本清单。

各依赖包的许可证类型和条款可能不同，本声明不对全部依赖的许可证类型做统一断言。如需审查具体依赖的许可证，请查阅对应包目录中的许可证文件。

---

## AI 生成的图片资源

### 项目封面插画

- **文件：** `docs/assets/palace-cover.png`
- **生成方式：** 通过 Codex 内置 imagegen 工具生成，并作为文档资产保存；并非本应用内置功能
- **提示词记录：** `docs/assets/imagegen-prompt.txt`

### 角色示例肖像

- **文件：** `public/portraits/` 目录下的 PNG 文件
- **性质：** 既有 AI 生成示例图片，用于初始角色展示
- **声明：** 这些图片不是真实用户的照片，项目方也不主张对其拥有独占版权

---

## 资产使用授权

在作者可授权的范围内，对本项目中的上述原创资产（包括 AI 生成的插画和示例肖像）不附加额外限制。

本声明不消灭任何第三方依据适用法律享有的权利。各第三方组件的权利归属和使用条件以其各自的许可证文件为准。
