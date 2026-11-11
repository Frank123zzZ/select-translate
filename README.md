# 划词翻译（Chrome 插件）

在网页上用左键划选文字，旁边会弹出翻译，网页原文不变。翻译由 Claude 完成。

| 划中的文字 | 翻译成 |
|---|---|
| 外文（英、日、韩、法等） | 简体中文 |
| 简体中文 | 英文 |
| 繁体中文 | 简体中文（含大陆习惯用语） |

## 功能

- **单词附带英文近义词**：只划一个词时，译文下方会多一行 2–3 个英文近义词；划短语或句子时只显示译文
  - 英文词给原词的近义词；中文或其他语言的词，给它英文译法的近义词
  - 会把这个词所在的句子一起发给模型，多义词按上下文翻译
  - 「一个词」指：不带空格的单词（`well-known`、`don't` 也算，前后标点自动忽略）；中文、日文不超过 4 个字

  ```
  非凡的；显著的
  近义词 extraordinary · striking · notable
  ```

- 弹窗自动放在选区附近的空白处；附近全是文字时放在选区上方，不挡住下文
- 支持网页里嵌入的 PDF 阅读器（如 Brightspace）和网页组件（Shadow DOM）
- 两种模型可切换：**Sonnet 5.5**（日常、快速）/ **Opus 5.5**（文学、细腻）
- 设置窗口右上角有总开关；ChatGPT、Claude、Gemini 等 AI 网站不翻译（列表见 `sites.js`，改完在 `chrome://extensions` 里刷新插件即可）

## 安装

1. 打开 `chrome://extensions`，打开右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本文件夹
3. 点工具栏上的「词」图标，填入 Anthropic API Key 并保存

API Key 在 [platform.claude.com](https://platform.claude.com) 创建，按用量计费。Key 只保存在你自己的浏览器里，不在本仓库中。

### 没有 API Key 也能用

- **Chrome 内置翻译**：不填 Key 时，自动改用 Chrome 自带的 AI 翻译（Translator API），免费、在本机运行。需要较新版本的 Chrome（138 及以上），第一次使用某个语言时会先下载翻译模型。没有近义词和 Opus 文学模式，质量也不如 Claude。
- **用 Claude / ChatGPT 翻译**：弹窗底部有按钮，点一下会打开 claude.ai 或 chatgpt.com，翻译要求和选中的文字已经填好，用的是你自己的 Claude 或 ChatGPT 账号。
  - 没填 Key：显示「用 Claude 翻译」和「用 ChatGPT 翻译」两个按钮
  - 填了 Claude 的 Key：译文已经来自 Claude，只显示「用 ChatGPT 翻译」，方便对比或在 ChatGPT 里追问；不需要的话，可在设置窗口里关掉「显示『用 ChatGPT 翻译』」

## 文件

- `manifest.json`：插件配置
- `content.js` / `content.css`：划词、弹窗定位
- `background.js`：调用 Claude API
- `popup.html` / `popup.js`：设置窗口
- `sites.js`：默认不翻译的网站
- `icons/`：图标
