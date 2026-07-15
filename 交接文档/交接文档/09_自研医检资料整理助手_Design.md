# 自研医检资料整理助手 Design

更新时间：2026-07-08

## 1. 设计目标

本设计文档用于说明“医检资料整理助手”的整体设计，包括技术栈、系统架构、核心模块、数据流、会话状态、界面交互、测试和部署策略。

产品核心体验不是宣传介绍，也不是传统结构化问卷，而是 AI chat。用户像和 AI 助手聊天一样上传资料、补充信息；AI 在聊天中自然追问，后台维护资料收集状态、知识库约束和资料包生成状态。

设计关键词：

- 简洁。
- 直观。
- 易操作。
- 类网页端 AI 对话体验。
- 强调多轮聊天式资料收集。
- 强调最终结果卡片。
- 支持患者资料包和医生资料包 ZIP 下载。
- 技术链路可控。
- 行为可测试。
- 不展示内部测试字段。
- 不制造医疗判断感。

## 2. 设计范围

本 Design 文档覆盖：

- 产品界面设计。
- 前端交互设计。
- 技术栈选择。
- 前后端架构。
- 核心业务模块。
- 数据对象。
- API 边界。
- OCR / 语音转文字 / LLM 调用链路。
- AI chat 会话编排。
- 系统提示词和知识库注入策略。
- 安全审查。
- 测试集和自动化评测。
- 部署和演示策略。

本 Design 文档不覆盖：

- 详细 UI 高保真稿。
- 具体模型供应商商务采购。
- 医疗知识库的医学内容扩写。
- 医生端复杂后台。
- HIS / LIS / PACS 对接。

## 3. 推荐技术栈

### 3.1 MVP 推荐方案

MVP 确定使用 Web 单页应用 + 后端 API 的自研架构。

确定技术栈：

```text
Monorepo：pnpm workspace
前端：Vite + React + TypeScript
UI：Tailwind CSS + shadcn/ui + lucide-react
前端请求：TanStack Query
后端：Node.js + TypeScript + NestJS
数据库：PostgreSQL
ORM：Prisma
文件存储：Docker volume，本地 uploads 目录
AI 接入：后端 AI Gateway，OpenAI-compatible HTTP adapter
Prompt：读取 deap_persona_integrated_prompt.md
知识库：新会话开始时注入 03_知识库文件
测试：Vitest + NestJS Jest + Playwright
部署：Docker Compose + Docker Desktop
```

前端：

- Vite。
- React。
- TypeScript。
- Tailwind CSS。
- shadcn/ui。
- lucide-react 图标库。
- TanStack Query。

选择 Vite 而不是 Next.js 的原因：

- 本产品是单页对话工具，不需要 SSR、SEO 和复杂路由。
- Vite 构建更轻，Docker 镜像更简单。
- 前端只负责界面和交互，后端 API 负责业务逻辑和 AI 编排。

后端：

- Node.js。
- TypeScript。
- NestJS。
- REST API 优先，必要时增加 SSE 流式输出。
- Prisma。

选择 NestJS 的原因：

- 模块化结构适合拆分会话、文件、AI、轻量 chat 编排、评测和安全审查。
- TypeScript 约束更强，适合后续多人协作。
- 比 Express 更适合这个项目的长期维护。

存储：

- Docker 部署默认使用 PostgreSQL。
- 使用 Prisma 管理 schema、迁移和类型安全数据库访问。
- 原始文件存 Docker volume，不直接塞进数据库。
- 后续如需云部署，可把文件存储替换成对象存储。

AI 能力：

- OCR / 图片理解：MVP 先通过后端 AI Gateway 接多模态模型，不先接专门 OCR 服务。
- 语音转文字：MVP 通过后端 AI Gateway 接 Speech-to-Text API。
- 对话生成：通过后端 AI Gateway 接 OpenAI-compatible LLM API。
- 安全审查：规则黑名单 + LLM 二次改写。
- 前端不直接调用 AI，不暴露模型地址和 API Key。

测试：

- 前端单元测试：Vitest。
- 后端单元测试：NestJS Jest。
- 规则测试：安全边界、追问格式、重复追问检查、资料包生成。
- 集成测试：患者 A 连续多轮聊天资料收集。
- 端到端测试：Playwright。

Docker 部署：

- 使用 Docker Compose。
- 一次拉起 Web、API、PostgreSQL 三个服务。
- 上传文件和数据库数据使用 Docker volume 持久化。
- API 容器启动时运行 Prisma migration。
- API Key 等敏感配置通过 `.env` 注入，不写进镜像和仓库。
- 目标是在 Docker Desktop 中启动 compose stack 后，后续可以通过 Docker Desktop 的 Start 按钮一键启动整套应用。

### 3.2 技术栈选择原则

选择技术栈时优先满足：

- 能快速做出演示成品。
- 多轮会话状态可控。
- OCR、语音、LLM 能替换供应商。
- 测试集能自动跑。
- 前端体验接近网页端 AI 助手。
- 不依赖 DEAP。
- 能通过 Docker Desktop 一键启动演示环境。

暂不追求：

- 多端原生应用。
- 大规模并发。
- 医院级系统集成。
- 复杂账号和权限体系。

## 4. 总体架构

系统由 5 层组成：

1. Web Client：对话界面、上传、语音、结果卡片、资料包下载。
2. API Server：会话、文件、追问、结果生成接口。
3. AI Gateway / AI Services：OCR、语音转文字、LLM 生成、安全改写。
4. Chat Domain：报告解析、知识库上下文、AI chat 会话编排、安全规则。
5. Storage：会话数据、上传文件、结构化资料、评测记录。

部署形态：

```text
Docker Compose App
├─ web：React 前端，提供网页界面
├─ api：NestJS 后端，提供业务 API 和 AI 编排
├─ db：PostgreSQL，保存会话、资料、结构化结果、评测记录
└─ volumes
   ├─ uploads：保存用户上传的演示文件
   └─ postgres-data：保存数据库数据
```

核心链路：

```text
用户上传资料/输入文字/语音
-> Document Ingestion
-> OCR 或 Speech To Text
-> Report Parser / Patient Fact Parser
-> Prompt + Knowledge Context
-> Chat Orchestrator
-> 下一条追问
-> 用户多轮补充
-> Patient View Generator
-> Safety Guard
-> 患者版结果卡片
-> PackageBuilder
-> 患者资料包 ZIP
-> Doctor Package Generator
-> Safety Guard
-> 医生版结果卡片
-> PackageBuilder
-> 医生资料包 ZIP
```

## 5. 核心模块设计

### 5.1 Web Client

负责：

- 展示 AI 对话窗口。
- 处理附件上传交互。
- 处理语音录制交互。
- 展示右上方资料面板。
- 展示患者版和医生版结果卡片。
- 触发患者资料包和医生资料包下载。
- 调用后端 API。

Web Client 不负责：

- 医疗规则判断。
- 知识库命中。
- 安全审查最终裁决。
- 直接保存长期病例。

### 5.2 API Server

负责：

- 创建会话。
- 接收上传文件。
- 接收文本输入。
- 接收语音文件或音频流。
- 调用 OCR、语音转文字、LLM。
- 调用领域模块。
- 返回下一条追问或结果卡片数据。

后端采用单体模块化 API 服务，不在 MVP 阶段拆成多个微服务。

推荐 NestJS 模块划分：

```text
ApiServer
├─ SessionsModule：会话创建、状态读取、消息提交
├─ FilesModule：附件上传、缩略图、文件元数据
├─ AudioModule：语音文件接收、转写调用
├─ DocumentsModule：OCR、PDF/图片文本提取、资料入库
├─ ReportsModule：报告结构化解析
├─ PromptModule：系统提示词加载、知识库文件加载、模型上下文组装
├─ QuestionGuardModule：追问格式轻量校验，确保每轮只问一条且不重复
├─ ChatModule：AI chat 会话编排、消息上下文、停止条件
├─ GenerationModule：患者版和医生版生成
├─ PackageModule：患者资料包 ZIP 和医生资料包 ZIP 生成
├─ SafetyModule：医疗安全审查和改写
├─ AiGatewayModule：统一封装 OCR、语音转文字、LLM、安全改写模型调用
├─ PrismaModule：数据库连接、Prisma Client、迁移配合
├─ EvaluationModule：患者 A 连续流程评测
└─ ConfigModule：环境变量、模型配置、存储路径
```

后端设计原则：

- 前端只负责展示和交互，不在前端判断医学规则。
- 追问主要由模型基于系统提示词和已注入知识库生成；后端只做轻量格式校验、重复问题检查和会话状态维护。
- 所有最终输出都经过 Safety Guard。
- 内部调试字段可以写日志或评测记录，但不能返回给用户界面。
- AI 服务供应商必须通过适配层接入，后续可替换模型。

### 5.3 Prompt And Knowledge Loader

Prompt And Knowledge Loader 负责在每个新 AI chat 会话开始时组装模型上下文。

系统提示词固定读取：

```text
C:\Users\lumoren\Documents\GitHub\2026年人工智能模型智能体大赛\交接文档\交接文档\02_DEAP配置文案\deap_persona_integrated_prompt.md
```

知识库文件固定读取目录：

```text
C:\Users\lumoren\Documents\GitHub\2026年人工智能模型智能体大赛\交接文档\交接文档\03_知识库文件
```

新会话启动时注入以下知识库文件内容：

```text
basic_question_bank.md
diagnosis_gap_rules.md
exam_body_part_table.md
normal_abnormal_rules.md
summary_templates.md
```

注入策略：

1. 创建新会话时，后端读取系统提示词文件。
2. 后端读取知识库目录下的固定知识库文件。
3. 后端把系统提示词作为 system prompt。
4. 后端把知识库内容作为会话级上下文注入模型。
5. 后续每轮对话调用模型时，都带上该会话的系统提示词、知识库上下文、历史消息摘要、已收集资料和当前用户输入。

这里的“注入”指模型请求上下文注入，不是在前端展示知识库，也不是把知识库内容作为普通聊天消息展示给用户。

要求：

- 前端不读取 Prompt 和知识库文件。
- Prompt 和知识库加载只发生在后端。
- 知识库文件名、命中规则和引用来源不得展示给用户。
- Prompt 和知识库可以缓存在服务内存中，但每个新 AI chat 会话必须使用当前版本组装模型上下文。
- 每次模型调用必须经过 PromptModule 组装上下文，不能由业务模块直接拼接零散 prompt。
- 如果知识库加载失败，不允许继续生成医疗相关输出，应返回可恢复错误。

推荐模型上下文顺序：

```text
1. System Prompt：deap_persona_integrated_prompt.md
2. Knowledge Context：03_知识库文件下的知识库内容
3. Session State：已上传资料、已补充信息、已问过的问题、当前阶段
4. Recent Messages：最近若干轮用户和 AI 消息
5. Current User Input：本轮用户输入
```

### 5.4 AI Gateway

AI Gateway 是后端里统一接 AI 的适配层。

它负责：

- 读取模型配置和 API Key。
- 封装不同模型供应商的请求格式。
- 给业务模块提供稳定方法。
- 记录调用耗时、错误类型和脱敏后的调试信息。
- 做超时、重试和兜底。

前端不能直接调用任何 AI API。

推荐接口：

```text
AiGateway.extractTextFromImage(file)
AiGateway.extractTextFromPdf(file)
AiGateway.transcribeAudio(audio)
AiGateway.parseReport(text)
AiGateway.generateFollowup(context)
AiGateway.generatePatientView(context)
AiGateway.generateDoctorPackage(context)
AiGateway.rewriteUnsafeOutput(text, safetyFindings)
```

注意：

- `parseReport` 可以先用 LLM 做结构化抽取，后续再替换成规则 + LLM 混合方案。
- `generateFollowup` 由模型基于系统提示词、知识库上下文和会话资料生成；后端只检查是否每轮只问一条、是否重复、是否越界。
- `rewriteUnsafeOutput` 只负责改写越界表达，不新增医学判断。
- AI Gateway 不保存 API Key 到数据库。

### 5.5 AI 接入配置

通过 `.env` 配置 AI 服务，不写死在代码里。

建议环境变量：

```text
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=

VISION_PROVIDER=openai_compatible
VISION_BASE_URL=
VISION_API_KEY=
VISION_MODEL=

SPEECH_PROVIDER=openai_compatible
SPEECH_BASE_URL=
SPEECH_API_KEY=
SPEECH_MODEL=

AI_REQUEST_TIMEOUT_MS=60000
AI_MAX_RETRIES=1
DEMO_MODE=false
```

如果 OCR、语音和 LLM 使用同一个供应商，可以共用 base url 和 key；如果后续替换成不同供应商，也不影响业务模块。

### 5.6 AI 调用链路

#### 上传报告图片

```text
前端上传图片
-> API FilesModule
-> DocumentsModule 判断资料类型
-> AiGateway.extractTextFromImage
-> ReportsModule.parseReport
-> ChatModule 更新会话
-> AiGateway.generateFollowup 生成下一条追问
-> QuestionGuardModule 做轻量校验
-> SafetyModule 检查追问文案
-> 返回给前端展示
```

#### 语音补充资料

```text
前端录音
-> API AudioModule
-> AiGateway.transcribeAudio
-> 返回转写文本到前端输入框
-> 用户确认发送
-> SessionsModule 记录为 PatientFact
-> ChatModule 继续下一轮追问
```

#### 生成患者版结果

```text
用户说没有要补充
-> ChatModule 进入 READY_FOR_PATIENT_VIEW
-> GenerationModule 组织上下文
-> AiGateway.generatePatientView
-> SafetyModule 审查和必要改写
-> 返回患者版结果卡片
```

#### 生成医生版资料包

```text
用户点击生成医生查看版
-> GenerationModule 组织医生版上下文
-> AiGateway.generateDoctorPackage
-> SafetyModule 审查和必要改写
-> 返回医生版结果卡片
```

### 5.7 AI 失败兜底

AI 调用失败时，不让前端崩掉。

兜底规则：

- 图片识别失败：提示用户上传更清晰图片或粘贴报告文字。
- 语音转写失败：提示用户重新录音或直接输入文字。
- 报告结构化失败：保留原始文本，询问用户补充检查类型、检查部位、诊断提示。
- 生成结果失败：提示稍后重试，不输出半截医疗内容。
- 安全审查失败：不直接返回未审查内容，提示系统暂时无法生成安全结果。

示例文案：

```text
这份资料暂时没有识别清楚。你可以上传更清晰的图片，或直接粘贴报告文字。
```

```text
语音转文字暂时失败。你可以重新录音，或直接输入文字补充。
```

```text
我暂时无法生成安全可靠的整理结果。你可以稍后重试，或继续补充报告文字。
```

### 5.8 演示模式下的 AI

演示模式不要求跳过 AI，但要保证可复现。

建议：

- 患者 A 的测试图片可以预置 OCR 结果缓存。
- 患者 A 的多轮追问可以固定期望链路。
- 最终患者版和医生版可以在安全规则通过后缓存。
- 演示仍走同一套接口和界面，不单独做假页面。

这样既能降低现场模型波动，也能展示完整产品流程。

### 5.9 Document Ingestion

负责把不同输入统一成资料对象：

- 图片。
- PDF。
- 文档。
- 报告文字。
- 语音转写文字。
- 患者口述补充。

每份资料必须记录来源：

- 用户上传图片。
- 用户上传 PDF。
- 用户粘贴文字。
- 患者语音转写。
- 患者手动补充。

### 5.10 OCR / Text Extraction

负责从报告图片、PDF、化验单、门诊记录中提取文字。

要求：

- 不编造看不清的内容。
- 识别失败时给出兜底。
- 原始影像图片不做诊断，只记录资料来源并询问是否有配套报告。

### 5.11 Speech To Text

负责将患者语音转成文字。

要求：

- 转写结果先进入输入框，用户确认后再发送。
- 转写内容标记为患者口述资料。
- 不把语音内容当成检查报告原文。
- 转写不清楚时让用户确认。

### 5.12 Report Parser

负责从报告文本中提取：

- 检查类型。
- 检查部位。
- 报告日期。
- 检查所见。
- 诊断建议 / 提示 / 结论。
- 报告关键词。

这些字段供内部追问和结果生成使用，不直接把内部标签展示给用户。

### 5.13 Question Guard

负责对模型生成的下一条追问做轻量校验。

它不是复杂规则引擎，也不替代模型做完整问卷决策。知识库主要通过 PromptModule 注入模型上下文，让模型在 chat 中自然追问。

输入：

- 模型生成的追问候选。
- 当前 chat 历史。
- 已问过的问题。
- 当前追问轮次。

输出：

- 是否只问一条。
- 是否重复。
- 是否包含诊断、治疗、复查周期等越界内容。
- 是否需要让模型重写。

注意：校验结果只进入内部日志或评测记录，不展示给用户。

### 5.14 Chat Orchestrator

负责控制 AI chat 会话编排。它维护聊天上下文、已收集资料、已问过的问题和停止条件，但不把体验做成传统表单式访谈，也不把后端做成复杂问卷引擎。

核心职责：

- 维护 AI chat 会话状态。
- 避免重复提问。
- 控制每轮只问一条。
- 判断停止条件。
- 决定何时生成患者版和医生版。

### 5.15 Patient View Generator

负责生成患者版病程梳理。

固定输出：

1. 报告里需要理解的关键词。
2. 医生可能会追问的信息。
3. 建议向医生确认的问题。
4. 就诊前建议补充的资料。

### 5.16 Doctor Package Generator

负责生成医生查看版资料包。

固定输出：

1. 资料来源。
2. 主诉或检查原因。
3. 病程时间线。
4. 检查资料整理。
5. 患者补充信息。
6. 已有检查资料。
7. 仍缺资料。
8. 安全声明。

### 5.17 Package Builder

负责把已生成的文字版结果和相关资料打包成 ZIP。

需要生成两个 ZIP：

1. 患者资料包 ZIP。
2. 医生资料包 ZIP。

患者资料包 ZIP 内容：

```text
患者版病程梳理.txt
资料清单.txt
```

医生资料包 ZIP 内容：

```text
医生查看版资料包.txt
资料来源清单.txt
原始附件/
```

医生资料包中的 `原始附件/` 放入用户上传的报告图片、PDF、文档等原始附件。患者资料包 MVP 阶段默认不放原始附件，只放患者能看懂的整理结果和资料清单；后续如需要，可以增加“包含原始附件”的选项。

ZIP 文件名规则：

```text
医检证据助手-患者资料包-YYYYMMDD-HHmm.zip
医检证据助手-医生资料包-YYYYMMDD-HHmm.zip
```

ZIP 生成限制：

- 不包含内部测试字段。
- 不包含知识库规则文件。
- 不包含 Evidence Graph。
- 不包含原文依据调试信息。
- 不包含模型调用日志。
- 不包含 API Key 或环境变量。

### 5.18 Safety Guard

负责输出前安全审查。

必须拦截或改写：

- 确诊。
- 良恶性判断。
- 严重程度判断。
- 用药建议。
- 手术建议。
- 穿刺建议。
- 复查周期。
- “多数为良性”。
- “恶性风险较高 / 较低”。
- “通常建议穿刺”。
- “需要复查”。

ZIP 打包前也必须复用 Safety Guard 的通过结果，不能把未审查文本打包下载。

## 6. 数据模型设计

MVP 核心对象：

```text
CaseSession
SourceDocument
ExtractedReport
PatientFact
FollowupQuestion
MissingInfoItem
PatientView
DoctorPackage
GeneratedZipPackage
SafetyReviewResult
EvaluationRun
```

### 6.1 CaseSession

表示一次患者资料整理会话。

关键字段：

- sessionId。
- status。
- createdAt。
- updatedAt。
- followupCount。
- askedQuestionIds。
- sourceDocumentIds。
- patientFactIds。
- systemPromptPath。
- knowledgeBasePath。
- knowledgeFileManifest。
- promptLoadedAt。
- knowledgeLoadedAt。

说明：

- `systemPromptPath` 固定指向 `deap_persona_integrated_prompt.md`。
- `knowledgeBasePath` 固定指向 `03_知识库文件`。
- `knowledgeFileManifest` 记录本次会话注入了哪些知识库文件及其版本信息或文件更新时间。

### 6.2 SourceDocument

表示用户上传或输入的一份资料。

关键字段：

- documentId。
- sessionId。
- sourceType：image / pdf / text / audio_transcript / patient_text。
- displayName。
- fileUrl。
- thumbnailUrl。
- extractedText。
- parseStatus。

### 6.3 ExtractedReport

表示从报告中抽取出的结构化信息。

关键字段：

- reportId。
- documentId。
- examType。
- bodyPart。
- reportDate。
- findings。
- impression。
- keywords。
- internalStatus。

`internalStatus` 只能内部使用，不展示 normal / abnormal / uncertain。

### 6.4 PatientFact

表示患者多轮补充的信息。

关键字段：

- factId。
- sessionId。
- category：reason / symptom / duration / history / medication / family_history / prior_exam / doctor_note。
- content。
- sourceType。
- createdAt。

### 6.5 GeneratedZipPackage

表示后端生成的可下载 ZIP 资料包。

关键字段：

- packageId。
- sessionId。
- packageType：patient / doctor。
- fileName。
- filePath。
- fileSize。
- generatedFromVersion。
- safetyReviewId。
- createdAt。

要求：

- 必须关联通过安全审查的患者版或医生版文本。
- 不保存 API Key、模型日志或内部调试内容。
- 医生 ZIP 可以引用原始附件，患者 ZIP 默认只包含患者版整理文本和资料清单。

## 7. API 设计

MVP API 可以先保持简单。

建议接口：

```text
POST /api/sessions
POST /api/sessions/{sessionId}/messages
POST /api/sessions/{sessionId}/files
POST /api/sessions/{sessionId}/audio
GET  /api/sessions/{sessionId}
POST /api/sessions/{sessionId}/generate-patient-view
POST /api/sessions/{sessionId}/generate-doctor-package
POST /api/sessions/{sessionId}/packages/patient
POST /api/sessions/{sessionId}/packages/doctor
GET  /api/sessions/{sessionId}/packages/{packageId}/download
POST /api/evaluations/run
```

### 7.1 创建 AI Chat 会话

`POST /api/sessions`

用途：

- 创建一个新的 AI chat 会话。
- 读取系统提示词文件。
- 读取 `03_知识库文件` 下的知识库文件。
- 组装本会话的初始模型上下文。
- 初始化会话状态。

要求：

- 如果系统提示词或知识库文件加载失败，不创建可继续医疗输出的会话。
- 返回错误时不暴露本地绝对路径给普通用户界面，日志中可以记录路径用于开发排查。

### 7.2 消息提交

`POST /api/sessions/{sessionId}/messages`

用途：

- 提交用户文字。
- 提交已确认的语音转写文字。
- 提交用户对追问的回答。

返回：

- 下一条追问。
- 或患者版结果卡片。
- 或医生版结果卡片。
- 或错误提示。

### 7.3 文件上传

`POST /api/sessions/{sessionId}/files`

用途：

- 上传图片。
- 上传 PDF。
- 上传文档。

返回：

- 文件展示信息。
- OCR / 解析状态。
- 下一条追问或需要补充文字的提示。

### 7.4 语音上传

`POST /api/sessions/{sessionId}/audio`

用途：

- 上传录音文件。
- 返回语音转写文本。

注意：

- 该接口只返回转写结果，不自动进入正式会话事实。
- 用户确认后再通过 messages 接口提交。

### 7.5 ZIP 资料包生成

`POST /api/sessions/{sessionId}/packages/patient`

用途：

- 生成患者资料包 ZIP。
- 使用已通过安全审查的患者版病程梳理。
- 返回下载信息。

`POST /api/sessions/{sessionId}/packages/doctor`

用途：

- 生成医生资料包 ZIP。
- 使用已通过安全审查的医生查看版资料包。
- 打包用户上传的原始附件。
- 返回下载信息。

返回示例：

```json
{
  "packageId": "pkg_xxx",
  "packageType": "patient",
  "fileName": "医检证据助手-患者资料包-20260708-1530.zip",
  "downloadUrl": "/api/sessions/session_xxx/packages/pkg_xxx/download"
}
```

### 7.6 ZIP 资料包下载

`GET /api/sessions/{sessionId}/packages/{packageId}/download`

用途：

- 下载已生成的 ZIP 文件。

要求：

- 校验 `packageId` 属于当前 `sessionId`。
- 设置正确的 `Content-Type: application/zip`。
- 设置下载文件名。
- 不允许通过路径参数读取任意服务器文件。

## 8. AI Chat 轻量状态设计

这些状态只用于控制 AI chat 的大阶段，不用于实现传统结构化问卷。

建议状态：

```text
WAITING_FIRST_INPUT
PARSING_INPUT
ASKING_FOLLOWUP
WAITING_USER_ANSWER
READY_FOR_PATIENT_VIEW
READY_FOR_DOCTOR_PACKAGE
COMPLETED
ERROR_NEEDS_USER_ACTION
```

核心转移：

- 用户上传首份资料：`WAITING_FIRST_INPUT -> PARSING_INPUT`。
- 解析成功：`PARSING_INPUT -> ASKING_FOLLOWUP`。
- 系统追问：`ASKING_FOLLOWUP -> WAITING_USER_ANSWER`。
- 用户补充：`WAITING_USER_ANSWER -> ASKING_FOLLOWUP`。
- 用户说没有要补充：`WAITING_USER_ANSWER -> READY_FOR_PATIENT_VIEW`。
- 生成患者版：`READY_FOR_PATIENT_VIEW -> COMPLETED`。
- 用户请求医生版：`COMPLETED -> READY_FOR_DOCTOR_PACKAGE -> COMPLETED`。

停止条件：

- 用户说“没有要补充的东西了”。
- 用户说“不知道”。
- 用户说“没有了”。
- 用户说“先到这里”。
- 用户要求生成病程分析。
- 用户要求给医生看。
- 主动追问达到上限。

## 9. 测试设计

测试目标不是证明模型“聪明”，而是证明完整产品链路可控。

### 9.1 患者 A 连续流程测试

必须有一个完整样例模拟患者 A：

1. 上传第一张检查报告图片。
2. 系统识别资料并提出第 1 条追问。
3. 患者 A 补充检查原因。
4. 系统继续追问症状或持续时间。
5. 患者 A 补充已有检查或病史。
6. 系统继续根据知识库追问。
7. 患者 A 表示没有要补充。
8. 系统生成患者版结果卡片。
9. 用户点击下载患者资料包。
10. 系统下载患者资料包 ZIP。
11. 用户点击生成医生查看版。
12. 系统生成医生版结果卡片。
13. 用户点击下载医生资料包。
14. 系统下载医生资料包 ZIP。

### 9.2 测试检查点

每次测试至少检查：

- 是否从第一份资料启动。
- 是否每轮只问一条。
- 是否没有重复追问。
- 是否按知识库优先级追问。
- 是否支持图片资料。
- 是否支持语音转文字补充。
- 是否能停止追问。
- 是否生成患者版三部分。
- 是否能生成医生版。
- 是否能下载患者资料包 ZIP。
- 是否能下载医生资料包 ZIP。
- 是否隐藏内部字段。
- 是否没有知识库引用展示。
- 是否没有医疗越界表达。

### 9.3 自动化测试建议

建议拆成三类：

- 规则单测：Question Guard、Safety Guard、资料包生成。
- 连续流程测试：患者 A 多轮聊天资料收集。
- 前端 E2E：上传、拖拽、语音按钮激活态、结果卡片生成。

## 10. 部署与演示设计

MVP 演示优先保证稳定可复现。

建议：

- 本地 Docker Desktop 部署 Web 应用。
- 使用固定脱敏测试数据。
- 演示前预置患者 A 测试资料。
- 保留日志但不记录真实身份信息。
- 演示环境和开发环境分开配置 API Key。

### 10.1 Docker Desktop 一键启动目标

最终交付时，项目根目录需要提供 Docker 部署文件，让使用者不需要手动安装 Node.js、数据库或前端依赖。

目标体验：

1. 安装并打开 Docker Desktop。
2. 在项目中配置 `.env`。
3. 首次运行启动脚本或 `docker compose up -d --build`。
4. Docker Desktop 中出现一个 compose 应用。
5. 后续演示时，只需要在 Docker Desktop 点击该应用的 Start 按钮，即可启动前端、后端和数据库。
6. 浏览器打开本地地址即可使用。

建议本地访问地址：

```text
http://localhost:3000
```

### 10.2 Docker Compose 服务

建议 `compose.yaml` 包含：

```text
web
api
db
```

`web`：

- 运行 React 前端构建产物。
- 对外暴露 `3000` 端口。
- 通过环境变量配置 API 地址。

`api`：

- 运行 NestJS 后端。
- 对内连接 PostgreSQL。
- 对外暴露 `3001` 端口，供前端调用。
- 读取 LLM、OCR、语音转文字等 API Key。
- 挂载 uploads volume 保存上传文件。

`db`：

- PostgreSQL。
- 使用 volume 持久化数据。
- 只在 Docker 网络内给 api 使用，默认不需要对外暴露。

### 10.3 需要交付的部署文件

实现阶段需要在项目根目录提供：

```text
package.json
pnpm-workspace.yaml
compose.yaml
.env.example
apps/web/Dockerfile
apps/api/Dockerfile
apps/api/prisma/schema.prisma
scripts/start-demo.ps1
scripts/stop-demo.ps1
```

建议项目目录：

```text
apps/
  web/                 # Vite + React 前端
  api/                 # NestJS 后端
    prisma/
      schema.prisma    # Prisma schema 和迁移
packages/
  shared/              # 前后端共享类型、常量、DTO
  knowledge/           # 知识库加载器；知识库源文件以交接文档/03_知识库文件为准
tests/
  e2e/                 # Playwright E2E
  fixtures/            # 患者 A 脱敏测试资料
data/
  uploads/             # 本地开发上传目录，Docker 中用 volume
```

`.env.example` 至少包含：

```text
APP_PORT=3000
API_PORT=3001
DATABASE_URL=postgresql://...
UPLOAD_DIR=/app/data/uploads
LLM_PROVIDER=openai_compatible
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
VISION_PROVIDER=openai_compatible
VISION_API_KEY=
VISION_BASE_URL=
VISION_MODEL=
SPEECH_PROVIDER=openai_compatible
SPEECH_API_KEY=
SPEECH_BASE_URL=
SPEECH_MODEL=
DEMO_MODE=false
```

注意：

- `.env` 不提交。
- API Key 不写入文档、日志、镜像和仓库。
- `uploads` 和数据库数据使用 Docker volume，重启后演示数据仍保留。

### 10.4 后端容器启动流程

API 容器启动时执行：

1. 读取环境变量。
2. 等待 PostgreSQL 可连接。
3. 运行数据库迁移。
4. 确认 uploads 目录可写。
5. 启动 NestJS 服务。
6. 暴露健康检查接口。

健康检查接口建议：

```text
GET /api/health
```

返回内容：

```json
{
  "status": "ok",
  "database": "ok",
  "uploads": "ok"
}
```

Docker Compose 应配置 healthcheck，避免前端在 API 未就绪时误报失败。

### 10.5 演示模式

为了保证比赛或汇报时稳定，建议增加演示模式：

```text
DEMO_MODE=true
```

演示模式能力：

- 可以预置患者 A 脱敏测试资料。
- 可以固定部分 OCR / LLM 返回，避免现场网络或模型波动导致演示失败。
- 可以保留完整多轮聊天资料收集链路，不跳过真实交互。

演示模式不能：

- 展示内部测试字段。
- 展示知识库文件名。
- 输出诊断或治疗建议。

演示链路：

1. 打开页面。
2. 点击上传附件。
3. 上传第一张报告图片。
4. 系统识别并开始追问。
5. 进行 2-3 轮补充。
6. 用户说没有要补充。
7. 展示患者版结果卡片。
8. 点击下载患者资料包，确认生成患者 ZIP。
9. 点击生成医生查看版。
10. 展示医生版结果卡片。
11. 点击下载医生资料包，确认生成医生 ZIP。

## 11. 页面整体形态

MVP 使用单页 Web 应用，不做复杂路由。

页面主体是类网页端 AI 对话窗口，整体结构为：

1. 中间：AI 对话消息区。
2. 底部：固定输入区。
3. 输入框左下角：上传附件按钮、语音输入按钮。
4. 右上方：用户上传附件和当前已收集资料面板。
5. 初始状态：助手头像、欢迎语、三个引导对话按钮。

不做：

- 宣传型首页。
- 大标题营销页。
- 复杂功能介绍。
- 独立的首屏隐私说明区。

隐私提醒可以只出现在欢迎语中，后续是否增加独立入口再定。

## 12. 初始开屏

初始开屏参考网页端 AI 助手的空会话状态。

组成：

1. 助手头像。
2. 欢迎语。
3. 三个引导对话按钮。
4. 底部输入框。

欢迎语固定为：

```text
你好，我是医检证据助手。请上传清晰报告图片或粘贴报告文字，我会整理已有资料、按优先级补充追问，并生成患者病程梳理或医生查看版资料包。请先删除姓名、手机号、身份证号、门诊号、住院号、检查号等隐私信息。
```

三个引导按钮固定为：

```text
帮我整理这份彩超报告
帮我看看还缺哪些就诊资料
生成医生查看版资料包
```

按钮行为：

- 点击“帮我整理这份彩超报告”：聚焦输入框，并引导用户上传报告图片或粘贴文字。
- 点击“帮我看看还缺哪些就诊资料”：聚焦输入框，并引导用户先上传现有报告。
- 点击“生成医生查看版资料包”：如果当前没有资料，先提示用户上传资料；如果已有资料，触发医生查看版生成。

## 13. 底部输入区

底部输入区是用户主要操作入口，固定在页面底部。

输入框支持：

- 输入文字。
- 粘贴报告文字。
- 粘贴患者补充信息。
- 显示已选择但尚未发送的附件卡片。
- 显示语音转写后的文字，供用户确认和修改。

输入框左下角放两个符号按钮：

1. 上传附件。
2. 语音输入。

这两个按钮只使用图标或图标加 tooltip，不使用复杂说明文字。

## 14. 上传附件交互

### 14.1 点击上传按钮

用户点击上传附件按钮后：

1. 页面整体加一层模糊遮罩。
2. 屏幕中央弹出上传方框。
3. 上传方框显示文案：

```text
将您的图片/检查报告单拖拽至此或点击此处上传文件
```

用户可以：

- 点击上传方框打开文件选择器。
- 将文件拖拽到上传方框内上传。
- 将文件直接拖拽到聊天框内上传。

### 14.2 上传成功后的输入框展示

文件上传成功后，不要立即把用户带走或跳页。

上传文件应显示在底部输入框内，参考 ChatGPT 网页端聊天框的附件卡片：

- 图片：显示缩略图和文件名。
- PDF：显示 PDF 符号和文件名。
- Word / 文档：显示文档符号和文件名。
- 其他文件：显示通用附件符号和文件名。

用户仍可以在同一条消息里补充文字说明，然后一起发送。

### 14.3 支持的资料类型

MVP 上传入口至少支持：

- 报告图片。
- 化验单图片。
- 门诊记录图片。
- PDF。
- 常见图片格式。

原始 CT / X 光 / MRI / 超声影像图片可以上传，但系统只记录为资料来源，不做影像诊断。

## 15. 语音输入交互

语音输入按钮采用“点击开始，再次点击停止”的模式。

流程：

1. 用户点击语音按钮。
2. 语音按钮进入激活态。
3. 界面明确提示用户语音转文字正在运行。
4. 用户再次点击语音按钮。
5. 停止录音和转写。
6. 转写文字进入输入框。
7. 用户可以修改确认后再发送。

要求：

- 不使用“按住说话”作为 MVP 主交互。
- 不把语音转写内容自动发送。
- 转写不确定时，让用户确认或修改。
- 语音转写资料来源需要进入内部会话状态，但不在用户界面展示成技术字段。

## 16. 右上方资料面板

右上方资料面板用于展示用户已经上传或补充了什么。

桌面端：

- 默认展开。
- 方便用户和评审看到系统正在逐步收集资料。

移动端：

- 默认收起。
- 通过“资料”按钮或图标展开。

面板内容分为两类：

```text
已上传资料
1. 甲状腺彩超报告图片
2. 甲状腺功能化验单

已补充信息
1. 检查原因：体检发现
2. 症状：暂无明显不适
3. 既往史：未补充
```

附件展示规则：

- 图片附件：文件名前显示缩略图。
- PDF：文件名前显示 PDF 符号。
- 文档：文件名前显示文档符号。
- 其他附件：文件名前显示通用附件符号。

禁止展示：

```text
normal / abnormal / uncertain
Evidence Graph
命中规则
命中知识库
原文依据
P1 / P2 / P3
Gap Engine
知识库文件名
引用文档
```

## 17. 对话消息区

对话消息区承载多轮聊天资料收集。

AI 每次只问一个最关键问题。问题后固定追加：

```text
如果没有再补充的或者不想继续上传了，可以告诉我没有要补充的东西了。
```

对话区要体现“逐步收集资料”，但不能输出内部分析字段。

AI 提问风格：

- 短。
- 具体。
- 一次只问一件事。
- 不使用吓人表达。
- 不给治疗建议。
- 不下诊断。

用户说“没有要补充的东西了”后，系统停止追问，并生成患者版结果卡片。

## 18. 患者版结果卡片

患者展示版不跳转页面，直接在聊天流中以结果卡片展示。

卡片标题：

```text
患者版病程梳理
```

卡片设计目标：

- 视觉上和普通聊天消息区分开。
- 让用户明确知道“这是最终给你看的东西”。
- 样式参考 Codex 计划卡片。

卡片固定包含四部分：

```text
一、报告里需要理解的关键词
二、医生可能会追问你的信息
三、建议向医生确认的问题
四、就诊前建议补充的资料
```

卡片底部按钮：

```text
复制患者版
下载患者资料包
生成医生查看版
```

内容要求：

- 大白话。
- 短句。
- 患者能看懂。
- 不输出报告原文依据。
- 不输出内部测试字段。
- 不输出知识库引用。
- 不判断良恶性。
- 不给用药、穿刺、手术、复查周期建议。

## 19. 医生查看版结果卡片

医生查看版也不跳转页面，直接在聊天流中以结果卡片展示。

卡片标题：

```text
医生查看版资料包
```

医生版卡片比患者版更结构化，适合复制给医生查看。

卡片底部按钮：

```text
复制医生版
下载医生资料包
```

医生版内容包含：

1. 资料来源。
2. 主诉或检查原因。
3. 病程时间线。
4. 检查资料整理。
5. 患者补充信息。
6. 已有检查资料。
7. 仍缺资料。
8. 安全声明。

医生版仍不能输出诊断或治疗建议。

## 20. 响应式设计

桌面端优先服务演示和完整流程观察。

桌面端布局：

- 中间对话区。
- 右上方资料面板默认展开。
- 底部输入区固定。

移动端布局：

- 对话区占主要空间。
- 资料面板默认收起。
- 通过顶部或右上角“资料”图标打开。
- 底部输入区保留上传附件和语音输入两个入口。

移动端必须保证：

- 输入框按钮不挤压。
- 附件卡片不撑破输入框。
- 结果卡片可完整阅读。
- 长文件名需要截断显示。

## 21. 视觉风格

整体风格：

- 干净。
- 医疗场景下可信。
- 不营销。
- 不花哨。
- 不使用过度装饰。

建议视觉方向：

- 背景简洁。
- 对话区留足阅读空间。
- 结果卡片边界清晰。
- 重点按钮清楚但不刺眼。
- 图标优先使用常见语义：附件、麦克风、复制、文件、PDF。

避免：

- 大面积炫彩渐变。
- 复杂插画。
- 装饰性卡片堆叠。
- 医疗恐吓感图形。
- 把内部规则做成可视化标签。

## 22. 状态与反馈

必须覆盖以下状态：

- 初始空会话。
- 上传弹窗打开。
- 文件拖拽悬停。
- 文件上传中。
- 文件上传成功。
- 文件上传失败。
- OCR / 解析中。
- AI 思考 / 生成中。
- 语音转写运行中。
- 语音转写结束。
- 患者版结果生成完成。
- 医生版结果生成完成。

状态反馈要短，不写复杂解释。

示例：

```text
正在识别报告文字...
正在整理资料...
正在生成患者版病程梳理...
语音转文字正在运行
```

## 23. 成功标准

设计验收时需要确认：

- 用户一进入页面就知道可以上传报告或输入文字。
- 用户能找到上传附件和语音输入。
- 用户能拖拽文件上传。
- 上传后能在输入框看到附件卡片。
- 右上方能看到已上传资料和已补充信息。
- AI 每轮只问一个问题。
- 用户说没有要补充后，能看到患者版结果卡片。
- 患者版卡片清楚显示三部分。
- 患者版卡片提供复制患者版和下载患者资料包按钮。
- 能从患者版卡片生成医生版卡片。
- 医生版卡片提供复制医生版和下载医生资料包按钮。
- 患者资料包和医生资料包均可下载 ZIP。
- 页面不展示内部测试字段、知识库引用或原文依据。
- 页面不出现诊断、用药、穿刺、手术、复查周期建议。

## 24. 待定问题

以下问题暂不阻塞 MVP：

1. 隐私提醒是否需要独立入口，入口放在何处。
2. 助手头像使用真人风格、抽象图标，还是品牌化头像。
3. 是否需要深色模式和浅色模式同时支持。
4. 是否需要导出 PDF / Word。
5. 是否需要历史会话列表。
6. 是否需要自动脱敏提示或脱敏检测。
