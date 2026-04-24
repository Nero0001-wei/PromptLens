# PromptLens

PromptLens 是一个浏览器扩展 MVP，用于从网页图片或本地图片中反推可直接用于 AI 绘图模型的提示词。

## 当前能力

- 右键网页图片生成提示词
- 上传本地图片生成提示词
- 支持简洁版、详细版、专业版
- 支持通用版、Midjourney、SDXL、Flux
- 支持提示词中英文切换
- 支持 PNG 元数据优先读取

## 项目结构

```text
.
├─ extension/                 浏览器扩展
│  ├─ assets/
│  ├─ manifest.json
│  ├─ background.js
│  ├─ inspector.html
│  ├─ inspector.css
│  ├─ inspector.js
│  ├─ options.html
│  └─ options.js
├─ backend/                   阿里云函数计算 HTTP Handler
│  └─ index.js
├─ deploy.ps1                 Windows 部署脚本
├─ .env.local.example         本地环境变量示例
└─ s.yaml                     Serverless Devs 配置
```

## 本地使用

1. 打开 Chrome 或 Edge 扩展管理页
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择 `extension` 目录
5. 在扩展设置中填写后端地址

## 后端部署

推荐使用项目根目录下的脚本：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy.ps1
```

部署脚本会从 `.env.local` 读取环境变量并注入阿里云函数。

## 关键环境变量

- `ZHIPU_API_KEY`：智谱 API Key，必填
- `APP_TOKEN`：可选，接口访问令牌
- `CORS_ORIGIN`：可选，默认 `*`
- `RATE_LIMIT_WINDOW_MS`：可选，默认 `600000`
- `RATE_LIMIT_MAX_REQUESTS`：可选，默认 `30`
- `RATE_LIMIT_DISABLED`：可选，默认 `false`

## 发布注意

- 不要把 `.env.local`、`deploy.ps1`、后端源码一起打进扩展包
- 发布 Chrome Web Store 时，只打包 `extension/` 目录内容
- 发布前请轮换所有已暴露过的密钥
