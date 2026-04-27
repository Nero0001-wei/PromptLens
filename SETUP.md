# PromptLens 多机开发说明

这份文档用于在多台电脑上继续开发 PromptLens，目标是：

- 代码同步走 Git
- 密钥和环境变量只保留在本机
- 每台电脑都能独立调试、部署和发布

## 一、哪些文件可以提交

建议提交到 Git 的内容：

- `extension/`
- `backend/`
- `README.md`
- `SETUP.md`
- `PRIVACY_POLICY.md`
- `STORE_LISTING.md`
- `RELEASE_CHECKLIST.md`
- `privacy-policy.html`
- `deploy-dev.ps1`
- `deploy-prod.ps1`
- `deploy-env.ps1`
- `s.dev.yaml`
- `s.prod.yaml`
- `.env.dev.local.example`
- `.env.prod.local.example`
- `.gitignore`

不要提交的内容：

- `.env.local`
- `.env.dev.local`
- `.env.prod.local`
- 任何真实密钥
- 本地部署日志
- `dist/`
- `.chrome-dev-profile/`
- `.s/`

## 二、新电脑第一次拉起项目

### 1. 拉取代码

先从远程仓库拉取项目代码到本地。

### 2. 准备环境变量

测试环境复制：

```text
.env.dev.local.example
```

生成：

```text
.env.dev.local
```

正式环境复制：

```text
.env.prod.local.example
```

生成：

```text
.env.prod.local
```

然后分别填写测试环境和正式环境要用的真实值，例如：

```env
ZHIPU_API_KEY=你的智谱密钥
APP_TOKEN=你的接口访问令牌
CORS_ORIGIN=*
RATE_LIMIT_WINDOW_MS=600000
RATE_LIMIT_MAX_REQUESTS=30
RATE_LIMIT_DISABLED=false
```

注意：

- `.env.dev.local` 和 `.env.prod.local` 永远不要提交到 Git
- 测试环境和正式环境建议使用不同的 `APP_TOKEN`
- `ZHIPU_API_KEY` 前期可以共用，正式上线后建议分开管理
- 换密钥后，只需要改本机对应环境文件再重新部署

### 3. 配置阿里云 `s config`

每台电脑都要单独配置一次 Serverless Devs 的阿里云凭证。

在本机终端执行：

```powershell
s config add --AccessKeyID 你的新AK --AccessKeySecret 你的新SK --AccountID 你的AccountID --access default
```

如果提示 `Alias already exists`，选择覆盖即可。

验证是否成功：

```powershell
s config get --access default
```

## 三、本地调试扩展

1. 打开 Chrome 或 Edge 扩展管理页
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择项目里的 `extension/` 目录

调试时：

- 修改前端文件后，去 `chrome://extensions` 点一次重新加载
- 再重新打开 PromptLens 小窗

## 四、部署后端

后端已拆成两个环境：

```text
dev 分支  -> reverse-prompt-api-dev
main 分支 -> reverse-prompt-api
```

部署测试环境：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy-dev.ps1
```

部署正式环境：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy-prod.ps1
```

如果在 CMD 里执行测试环境部署：

```cmd
powershell -ExecutionPolicy Bypass -File D:\图片反推提示词助手\deploy-dev.ps1
```

如果在 CMD 里执行正式环境部署：

```cmd
powershell -ExecutionPolicy Bypass -File D:\图片反推提示词助手\deploy-prod.ps1
```

部署成功后，终端会输出对应环境的 `system_url`。在浏览器里打开：

```text
https://你的环境地址/health
```

## 五、推荐开发流程

建议至少维护两个分支：

- `main`：稳定、可发布版本
- `dev`：日常开发版本

推荐流程：

1. 在 `dev` 分支开发
2. 本地调试扩展
3. 使用 `.\deploy-dev.ps1` 部署并验证测试后端
4. 提交代码并推送
5. 另一台电脑拉取最新代码继续开发
6. 稳定后再合并到 `main`
7. 使用 `.\deploy-prod.ps1` 部署正式后端

## 六、换电脑时最容易忘的事

换到另一台电脑后，至少检查：

- [ ] `.env.dev.local` 是否已经创建并填入真实值
- [ ] `.env.prod.local` 是否已经创建并填入真实值
- [ ] `s config` 是否已配置
- [ ] 扩展是否重新加载到浏览器
- [ ] 测试后端和正式后端是否按需部署

## 七、安全建议

- 密钥不要放在截图、聊天记录或终端录屏里
- 轮换密钥后，旧密钥确认无用再删除
- 每台电脑都只保留当前有效密钥
- 如果某台电脑丢失或转给他人，立即重置所有相关密钥

## 八、发布时注意

Chrome Web Store 上传时，只打包：

```text
extension/
```

不要把这些一起上传：

- `backend/`
- `.env.dev.local`
- `.env.prod.local`
- `deploy-dev.ps1`
- `deploy-prod.ps1`
- `s.dev.yaml`
- `s.prod.yaml`
- `dist/`

发布前可对照：

```text
RELEASE_CHECKLIST.md
```
