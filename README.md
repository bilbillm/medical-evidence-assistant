# 医检资料整理助手 MVP

这是基于 PRD 和 Design 搭建的自研 Web AI chat MVP 骨架。

## 当前能力

- 前端 AI chat 页面：欢迎语、三个引导按钮、底部输入区、上传入口、真实浏览器录音入口、右侧资料面板。
- 后端 API 骨架：会话、消息、文件上传、音频上传转写、患者版生成、医生版生成、ZIP 资料包生成。
- Prompt + 知识库注入：新建会话时读取系统提示词和 `03_知识库文件`。
- 多轮访谈骨架：每轮只追问一条，并追加停止提示。
- 结果卡片：患者版病程梳理、医生查看版资料包。
- ZIP 下载骨架：患者资料包 ZIP、医生资料包 ZIP。
- 患者 A 连续流程测试。

## 本地验证

```powershell
npm install --include-workspace-root
npm run build
npm test
```

分别启动开发服务：

```powershell
npm run dev:api
npm run dev:web
```

访问：

```text
http://localhost:3000
```

## Docker 启动

先确保 Docker Desktop 已启动，然后运行：

```powershell
npm run start:demo
```

启动脚本会关闭 BuildKit 后再构建，避免部分 Windows / Docker Desktop 环境出现 BuildKit session header 错误。

停止：

```powershell
npm run stop:demo
```

Docker Compose 会启动：

- `web`：React 前端，端口 `3000`。
- `api`：NestJS API，端口 `3001`。
- `db`：PostgreSQL。

## AI 接入说明

当前 AI Gateway 是 deterministic mock，用于先打通产品闭环。后续接真实模型时，主要替换：

```text
apps/api/src/modules/mock-ai.gateway.ts
```

DeepSeek 已接入追问、患者版和医生版生成。`.env` 配置：

```text
LLM_PROVIDER=deepseek
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=你的 DeepSeek API Key
LLM_MODEL=deepseek-v4-pro
LLM_THINKING_ENABLED=true
LLM_REASONING_EFFORT=high
```

开启 DeepSeek 深度思考后，后端只会把最终回答流式传给前端；DeepSeek 返回的 `reasoning_content` 不会写入会话消息，也不会显示在聊天界面。

配置后重启：

```powershell
npm run start:demo
```

阿里云通用文字识别已接入图片 OCR。`.env` 配置：

```text
VISION_PROVIDER=aliyun_ocr
ALIYUN_ACCESS_KEY_ID=你的 AccessKey ID
ALIYUN_ACCESS_KEY_SECRET=你的 AccessKey Secret
ALIYUN_OCR_ENDPOINT=ocr-api.cn-hangzhou.aliyuncs.com
```

当前 OCR 只用于报告图片文字提取；PDF 仍需要转成图片或粘贴报告文字。

语音转文字已经接好浏览器录音和后端音频上传。默认 `.env` 使用：

```text
SPEECH_PROVIDER=mock
```

要接真实 Speech-to-Text，把 `.env` 改为：

```text
SPEECH_PROVIDER=openai_compatible
SPEECH_BASE_URL=https://your-provider.example/v1
SPEECH_API_KEY=你的密钥
SPEECH_MODEL=你的语音转写模型
```

如果使用讯飞中英识别大模型：

```text
SPEECH_PROVIDER=iflytek
IFLYTEK_APP_ID=你的 APPID
IFLYTEK_API_KEY=你的 APIKey
IFLYTEK_API_SECRET=你的 APISecret
IFLYTEK_IAT_HOST=iat.xf-yun.com
IFLYTEK_IAT_PATH=/v1
```

前端流程是：点击麦克风开始录音，再点一次停止；后端转写完成后，文字进入输入框，由用户确认或修改后再发送。

需要保留的边界：

- 前端不直接调用模型。
- 系统提示词和知识库由后端注入。
- 最终输出必须经过安全审查。
- 不展示内部标签、知识库命中、引用文档、Evidence Graph 或原文依据。
