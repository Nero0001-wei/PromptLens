# PromptLens 发布检查清单

## 扩展包内容

发布时只打包 `extension/` 目录，不要把以下内容放进扩展包：

- `.env.local`
- `.env.dev.local`
- `.env.prod.local`
- `.env.dev.local.example`
- `.env.prod.local.example`
- `deploy-dev.ps1`
- `deploy-prod.ps1`
- `backend/`
- `s.yaml`
- `s.dev.yaml`
- `s.prod.yaml`
- 任意密钥、日志、截图、调试文件

## 发布前确认

- [ ] `manifest.json` 版本号已递增
- [ ] 扩展图标已配置：16 / 32 / 48 / 128
- [ ] 名称、描述、图标显示正常
- [ ] 右键菜单文案无乱码
- [ ] 设置页文案无乱码
- [ ] 中英文切换可用
- [ ] 正面提示词和负面提示词复制可用
- [ ] 至少完成一轮 8 类场景回归测试
- [ ] `dev` 分支只部署到测试 FC：`reverse-prompt-api-dev`
- [ ] `main` 分支只部署到正式 FC：`reverse-prompt-api`
- [ ] 正式插件配置的是正式后端 URL
- [ ] 已轮换所有暴露过的密钥
- [ ] 已准备隐私政策

## 打包建议

Chrome Web Store 上传时，建议把 `extension/` 目录单独复制到一个干净目录，再压缩上传，避免误打包无关文件。
