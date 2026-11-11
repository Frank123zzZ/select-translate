# 划词翻译（Chrome 插件）

在网页上用左键划选文字，旁边会弹出翻译，网页原文不变。翻译由 Claude 完成。

| 划中的文字 | 翻译成 |
|---|---|
| 外文（英、日、韩、法等） | 简体中文 |
| 简体中文 | 英文 |
| 繁体中文 | 简体中文（含大陆习惯用语） |

## 功能

- 弹窗自动放在选区附近的空白处；附近全是文字时放在选区上方，不挡住下文
- 支持网页里嵌入的 PDF 阅读器（如 Brightspace）和网页组件（Shadow DOM）
- 两种模型可切换：**Sonnet 5.5**（日常、快速）/ **Opus 5.5**（文学、细腻）
- 总开关 + 按网站开关；ChatGPT、Claude、Gemini 等 AI 网站默认不翻译（列表见 `sites.js`）

## 安装

1. 打开 `chrome://extensions`，打开右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本文件夹
3. 点工具栏上的「词」图标，填入 Anthropic API Key 并保存

API Key 在 [platform.claude.com](https://platform.claude.com) 创建，按用量计费。Key 只保存在你自己的浏览器里，不在本仓库中。

## 文件

- `manifest.json`：插件配置
- `content.js` / `content.css`：划词、弹窗定位
- `background.js`：调用 Claude API
- `popup.html` / `popup.js`：设置窗口
- `sites.js`：默认不翻译的网站
- `icons/`：图标
