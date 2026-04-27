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
├─ deploy-dev.ps1             部署测试环境
├─ deploy-prod.ps1            部署正式环境
├─ deploy-env.ps1             双环境部署公共脚本
├─ .env.dev.local.example     测试环境变量示例
├─ .env.prod.local.example    正式环境变量示例
├─ s.dev.yaml                 测试环境 Serverless Devs 配置
└─ s.prod.yaml                正式环境 Serverless Devs 配置
```

## 本地使用

1. 打开 Chrome 或 Edge 扩展管理页
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择 `extension` 目录
5. 在扩展设置中填写后端地址

## 后端部署

后端已经拆成测试环境和正式环境：

```text
dev 分支  -> reverse-prompt-api-dev
main 分支 -> reverse-prompt-api
```

测试环境部署：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy-dev.ps1
```

正式环境部署：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy-prod.ps1
```

部署脚本会分别从 `.env.dev.local` 或 `.env.prod.local` 读取环境变量并注入对应的阿里云函数。`deploy.ps1` 已改为安全提示，不再直接部署。

## 关键环境变量

- `ZHIPU_API_KEY`：智谱 API Key，必填
- `APP_TOKEN`：可选，接口访问令牌
- `CORS_ORIGIN`：可选，默认 `*`
- `RATE_LIMIT_WINDOW_MS`：可选，默认 `600000`
- `RATE_LIMIT_MAX_REQUESTS`：可选，默认 `30`
- `RATE_LIMIT_DISABLED`：可选，默认 `false`

## 发布注意

- 不要把 `.env.dev.local`、`.env.prod.local`、后端源码一起打进扩展包
- 发布 Chrome Web Store 时，只打包 `extension/` 目录内容
- 发布前请轮换所有已暴露过的密钥
