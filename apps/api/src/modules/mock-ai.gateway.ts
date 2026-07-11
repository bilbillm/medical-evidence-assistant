import { Injectable } from '@nestjs/common';
import { PatientFactDto, ResultCardDto } from '@medical-evidence/shared';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import OcrClientModule, { RecognizeGeneralRequest } from '@alicloud/ocr-api20210707';
import { Config } from '@alicloud/openapi-client';
import WebSocket from 'ws';
import { CaseSession } from './sessions.service.js';

const stopHint = '如果没有再补充的或者不想继续上传了，可以告诉我没有要补充的东西了。';

interface IflytekResponse {
  header?: {
    code?: number;
    message?: string;
    status?: number;
  };
  payload?: {
    result?: {
      text?: string;
    };
  };
}

type FactSummaryInput = Pick<PatientFactDto, 'label' | 'content'>;

export type FollowupAction = 'ask' | 'generate_patient_view';

export interface FollowupDecision {
  action: FollowupAction;
  reply: string;
  missingCriticalInfo: string[];
}

interface DeepSeekRequestOptions {
  includeKnowledge?: boolean;
  temperature?: number;
  jsonOutput?: boolean;
  stream?: boolean;
}

interface DeepSeekMessage {
  role: 'system' | 'user';
  content: string;
}

@Injectable()
export class MockAiGateway {
  async extractTextFromFile(file?: Express.Multer.File): Promise<string> {
    const fileName = file?.originalname ?? '';
    const lowerName = fileName.toLowerCase();
    const provider = process.env.VISION_PROVIDER ?? 'mock';

    if (lowerName.endsWith('.txt') || file?.mimetype?.startsWith('text/')) {
      return file?.buffer?.toString('utf8').trim() || '用户上传了一份文字资料。';
    }

    if (lowerName.endsWith('.pdf')) {
      return '用户上传了一份 PDF 检查资料，MVP 当前记录文件来源，后续接入 PDF 文本提取。';
    }

    if (!this.isImageFile(lowerName, file?.mimetype)) {
      return '用户上传了一份检查资料，当前已记录文件来源；如需精确分析，请补充报告中的文字内容或上传清晰图片。';
    }

    if (provider === 'aliyun_ocr') {
      if (!file?.buffer?.length) {
        throw new Error('Image file is required for Aliyun OCR');
      }
      return this.extractTextWithAliyunOcr(file);
    }

    return '图片已上传，当前未启用真实 OCR；系统只记录了图片来源。要分析报告内容，请启用 VISION_PROVIDER=aliyun_ocr，或先粘贴报告文字。';
  }

  private isImageFile(fileName: string, mimeType?: string) {
    return Boolean(mimeType?.startsWith('image/')) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(fileName);
  }

  private async extractTextWithAliyunOcr(file: Express.Multer.File): Promise<string> {
    if (file.originalname.toLowerCase().endsWith('.pdf')) {
      return '用户上传了一份 PDF 检查资料。阿里云通用文字识别当前不支持 PDF，请上传报告图片或粘贴报告文字。';
    }

    const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
    const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
    if (!accessKeyId || !accessKeySecret) {
      throw new Error('ALIYUN_ACCESS_KEY_ID and ALIYUN_ACCESS_KEY_SECRET are required when VISION_PROVIDER=aliyun_ocr');
    }

    const OcrClient = OcrClientModule.default;
    const client = new OcrClient(new Config({
      accessKeyId,
      accessKeySecret,
      endpoint: process.env.ALIYUN_OCR_ENDPOINT ?? 'ocr-api.cn-hangzhou.aliyuncs.com'
    }));
    const request = new RecognizeGeneralRequest({
      body: Readable.from(file.buffer)
    });
    const response = await client.recognizeGeneral(request);
    const data = response.body?.data;
    const parsed = typeof data === 'string' ? JSON.parse(data) as { content?: string } : data as { content?: string } | undefined;
    const content = parsed?.content?.trim();
    if (!content) {
      throw new Error('Aliyun OCR returned empty text');
    }
    return content;
  }

  async transcribeAudio(audio?: Express.Multer.File): Promise<string> {
    const provider = process.env.SPEECH_PROVIDER ?? 'mock';
    if (provider === 'mock') {
      return '体检时发现的，最近没有明显不舒服。';
    }

    if (!audio?.buffer?.length) {
      throw new Error('Audio file is required for speech transcription');
    }

    if (provider === 'iflytek') {
      return this.transcribeWithIflytek(audio);
    }

    if (provider !== 'openai_compatible') {
      throw new Error(`Unsupported speech provider: ${provider}`);
    }

    return this.transcribeWithOpenAiCompatible(audio);
  }

  private transcribeWithIflytek(audio: Express.Multer.File): Promise<string> {
    const appId = process.env.IFLYTEK_APP_ID;
    const apiKey = process.env.IFLYTEK_API_KEY;
    const apiSecret = process.env.IFLYTEK_API_SECRET;

    if (!appId || !apiKey || !apiSecret) {
      throw new Error('IFLYTEK_APP_ID, IFLYTEK_API_KEY and IFLYTEK_API_SECRET are required');
    }

    const host = process.env.IFLYTEK_IAT_HOST ?? 'iat.xf-yun.com';
    const path = process.env.IFLYTEK_IAT_PATH ?? '/v1';
    const url = this.buildIflytekUrl(host, path, apiKey, apiSecret);
    const pcm = this.extractPcm(audio.buffer);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const words: string[] = [];
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error('Iflytek speech transcription timed out'));
        }
      }, Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 60000));

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        ws.close();
        if (error) {
          reject(error);
        } else {
          resolve(words.join('').trim());
        }
      };

      ws.on('open', () => {
        const chunks = this.chunkBuffer(pcm, 1280);
        chunks.forEach((chunk, index) => {
          const status = index === 0 ? 0 : index === chunks.length - 1 ? 2 : 1;
          const frame = {
            header: {
              app_id: appId,
              status
            },
            parameter: {
              iat: {
                language: 'zh_cn',
                accent: 'mandarin',
                domain: 'slm',
                result: {
                  encoding: 'utf8',
                  compress: 'raw',
                  format: 'json'
                }
              }
            },
            payload: {
              audio: {
                encoding: 'raw',
                sample_rate: 16000,
                channels: 1,
                bit_depth: 16,
                seq: index,
                status,
                audio: chunk.toString('base64')
              }
            }
          };
          setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(frame)), index * 40);
        });
      });

      ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString()) as IflytekResponse;
          if (response.header?.code && response.header.code !== 0) {
            finish(new Error(`Iflytek speech transcription failed: ${response.header.code} ${response.header.message ?? ''}`));
            return;
          }

          const textBase64 = response.payload?.result?.text;
          if (textBase64) {
            words.push(this.parseIflytekResult(textBase64));
          }

          if (response.header?.status === 2) {
            finish();
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Failed to parse Iflytek response'));
        }
      });

      ws.on('error', (error) => finish(error));
      ws.on('close', () => {
        if (!settled) {
          finish();
        }
      });
    });
  }

  private async transcribeWithOpenAiCompatible(audio: Express.Multer.File): Promise<string> {
    const baseUrl = process.env.SPEECH_BASE_URL;
    const apiKey = process.env.SPEECH_API_KEY;
    const model = process.env.SPEECH_MODEL;

    if (!baseUrl || !apiKey || !model) {
      throw new Error('SPEECH_BASE_URL, SPEECH_API_KEY and SPEECH_MODEL are required');
    }

    const formData = new FormData();
    const fileName = audio.originalname || 'voice.webm';
    const mimeType = audio.mimetype || 'audio/webm';
    const arrayBuffer = new ArrayBuffer(audio.buffer.length);
    new Uint8Array(arrayBuffer).set(audio.buffer);
    formData.append('file', new Blob([arrayBuffer], { type: mimeType }), fileName);
    formData.append('model', model);

    const endpoint = `${baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Speech transcription failed: ${response.status} ${body}`);
    }

    const data = await response.json() as { text?: string };
    return data.text?.trim() ?? '';
  }

  private buildIflytekUrl(host: string, path: string, apiKey: string, apiSecret: string) {
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
    const signature = createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64');
    const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const authorization = Buffer.from(authorizationOrigin).toString('base64');
    const params = new URLSearchParams({ authorization, date, host });
    return `wss://${host}${path}?${params.toString()}`;
  }

  private extractPcm(buffer: Buffer) {
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') {
      const dataIndex = buffer.indexOf(Buffer.from('data'));
      if (dataIndex >= 0) {
        const dataStart = dataIndex + 8;
        return buffer.subarray(dataStart);
      }
    }
    return buffer;
  }

  private chunkBuffer(buffer: Buffer, chunkSize: number) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      chunks.push(buffer.subarray(offset, offset + chunkSize));
    }
    return chunks.length > 0 ? chunks : [Buffer.alloc(0)];
  }

  private parseIflytekResult(textBase64: string) {
    const jsonText = Buffer.from(textBase64, 'base64').toString('utf8');
    const result = JSON.parse(jsonText) as { ws?: Array<{ cw?: Array<{ w?: string }> }> };
    return result.ws?.flatMap((item) => item.cw ?? []).map((candidate) => candidate.w ?? '').join('') ?? '';
  }

  async nextFollowup(session: CaseSession, includeKnowledge = false): Promise<string> {
    if (this.shouldUseDeepSeek()) {
      const decision = await this.nextFollowupDecision(session, includeKnowledge);
      return decision.reply;
    }

    const asked = session.askedQuestions.length;
    if (asked === 0) {
      return `这次做检查的原因是什么，是体检发现、因为不舒服去查，还是复查？\n\n${stopHint}`;
    }
    if (asked === 1) {
      return `目前有没有和这个检查部位相关的不舒服，比如疼痛、肿胀、胸闷、腹痛或其他症状？\n\n${stopHint}`;
    }
    if (asked === 2) {
      return `以前是否做过同部位检查，或者有没有医生已经看过这份报告？\n\n${stopHint}`;
    }
    return `还有没有相关病史、家族史、用药史，或者已经做过的补充检查结果可以提供？\n\n${stopHint}`;
  }

  async nextFollowupDecision(session: CaseSession, includeKnowledge = false): Promise<FollowupDecision> {
    if (this.shouldUseDeepSeek()) {
      const result = await this.callDeepSeekJson<Partial<FollowupDecision>>(
        session,
        `${includeKnowledge ? '请基于系统提示词、首次注入的知识库、已上传资料、已补充信息、已问过的问题和最新用户消息' : '请基于系统提示词、已上传资料、已补充信息、已问过的问题和最新用户消息'}，判断下一步动作。只返回合法 JSON：{"action":"ask","reply":"...","missingCriticalInfo":["..."]} 或 {"action":"generate_patient_view","reply":"","missingCriticalInfo":[]}。普通追问阶段不得输出患者就诊准备卡正文；如果仍缺检查原因、症状和持续时间、既往相关检查、医生已给出的说明等关键资料，必须返回 action=ask，reply 只问一个最关键问题并追加固定停止提示。只有用户明确说没有要补充、结束访谈、要求生成病程分析，或关键资料已经基本齐备时，才允许 action=generate_patient_view。阶段性说明不能冒充最终患者就诊准备卡。不要生成医生查看版资料包，除非用户明确要求。如果最新用户消息只是寒暄、问你是谁、问能做什么，返回 action=ask，并在 reply 中自然回应后轻轻引导用户上传或粘贴资料。不要输出内部字段、引用文档或原文依据。`,
        { includeKnowledge, temperature: 0.35 }
      );
      return this.normalizeFollowupDecision(result);
    }

    return {
      action: 'ask',
      reply: await this.nextFollowup(session, includeKnowledge),
      missingCriticalInfo: []
    };
  }

  async summarizePatientFacts(session: CaseSession): Promise<FactSummaryInput[]> {
    if (session.facts.length === 0) {
      return [];
    }

    if (this.shouldUseDeepSeek()) {
      const result = await this.callDeepSeekJson<{ items: FactSummaryInput[] }>(
        session,
        '请把患者已补充信息整理成右侧面板展示用摘要。只返回 JSON：{"items":[{"label":"检查原因","content":"..."},{"label":"症状情况","content":"..."}]}。只总结患者已明确提供的病程、症状、检查原因、既往检查、病史等资料；忽略寒暄、问候、问你是谁、问软件怎么用等非病例资料。不要推测，不要诊断，不要给治疗建议。label 使用 2-6 个汉字，content 用一句大白话，重复信息要合并，最多 6 条；如果没有可展示的患者资料则返回 {"items":[]}。'
      );
      return result.items ?? [];
    }

    const merged = new Map<string, string[]>();
    for (const fact of session.facts) {
      merged.set(fact.label, [...(merged.get(fact.label) ?? []), fact.content]);
    }
    return Array.from(merged.entries()).map(([label, content]) => ({
      label,
      content: content.join('；')
    }));
  }

  private normalizeFollowupDecision(result: Partial<FollowupDecision>): FollowupDecision {
    const action: FollowupAction = result.action === 'generate_patient_view' ? 'generate_patient_view' : 'ask';
    const reply = typeof result.reply === 'string' ? result.reply.trim() : '';
    const missingCriticalInfo = Array.isArray(result.missingCriticalInfo)
      ? result.missingCriticalInfo.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];

    if (action === 'generate_patient_view') {
      return { action, reply, missingCriticalInfo };
    }

    return {
      action: 'ask',
      reply: reply || `我还需要继续确认一项关键资料。\n\n${stopHint}`,
      missingCriticalInfo
    };
  }

  async generatePatientView(session: CaseSession): Promise<ResultCardDto> {
    if (this.shouldUseDeepSeek()) {
      return this.callDeepSeekJson<ResultCardDto>(
        session,
        '请生成患者就诊准备卡。只返回 JSON，结构必须是 {"title":"患者就诊准备卡","sections":[{"title":"一、这份资料目前说明了什么","content":["..."]},{"title":"二、报告里需要理解的关键词","content":["..."]},{"title":"三、建议向医生确认的问题","content":["..."]},{"title":"四、医生可能会追问你的信息","content":["..."]},{"title":"五、就诊前建议补充的资料","content":["..."]}]}。内容必须大白话，只整理真正的病例资料；忽略寒暄、问候、问你是谁、问软件怎么用等非病例内容。不能诊断，不能给治疗、用药、穿刺、手术、复查周期建议，不能输出内部字段、知识库引用、原文依据。'
      );
    }

    const sourceText = session.documents.length > 0 ? `这次资料主要来自 ${session.documents[0].displayName}。` : '这次资料主要来自你提供的文字信息。';
    return {
      title: '患者就诊准备卡',
      sections: [
        {
          title: '一、这份资料目前说明了什么',
          content: [
            `${sourceText}系统整理到报告里有需要医生结合临床进一步判断的提示。`,
            '你已经补充了一些检查原因、症状或既往情况，后续就诊时可以把这些一起告诉医生。',
            '目前还有部分资料可能不完整，例如既往检查、相关化验或医生已经给过的说明。'
          ]
        },
        {
          title: '二、报告里需要理解的关键词',
          content: [
            '结节：意思是报告里看到一个局部小异常，需要医生结合大小、形态和变化情况判断。',
            '低回声：这是超声图像上的一种描述，不等于确诊某种病。',
            'TI-RADS：这是甲状腺超声报告中常见的分级表达，具体含义需要医生结合完整报告和原始影像判断。'
          ]
        },
        {
          title: '三、建议向医生确认的问题',
          content: [
            '这份报告里的提示，需要结合哪些病史、体格检查或原始影像一起看？',
            '我目前还缺哪些资料，是否需要补充，请医生结合情况判断。',
            '后续是否需要进一步检查或随访安排，请医生结合原始影像和临床资料判断。'
          ]
        },
        {
          title: '四、医生可能会追问你的信息',
          content: [
            '这次检查是体检发现、复查，还是因为某些不舒服去检查？',
            '有没有相关症状，例如疼痛、发热、黄疸、消化不适，持续了多久？',
            '以前有没有做过同部位检查，结果和这次相比有没有变化？'
          ]
        },
        {
          title: '五、就诊前建议补充的资料',
          content: [
            '如果有既往同部位检查、相关化验结果或医生已经给出的说明，建议一起带给医生看。',
            '如果只有图片但没有报告文字，建议补充清晰报告文字或原始报告。',
            '就诊时请医生结合完整病史、体格检查、原始影像和必要化验综合判断。'
          ]
        }
      ]
    };
  }

  async *streamPatientView(session: CaseSession): AsyncGenerator<string> {
    if (this.shouldUseDeepSeek()) {
      yield* this.streamDeepSeekText(
        session,
        '请生成患者就诊准备卡。只输出正文，不要输出 JSON。格式必须包含标题“患者就诊准备卡”，并依次包含“一、这份资料目前说明了什么”“二、报告里需要理解的关键词”“三、建议向医生确认的问题”“四、医生可能会追问你的信息”“五、就诊前建议补充的资料”。内容必须大白话，只整理真正的病例资料；忽略寒暄、问候、问你是谁、问软件怎么用等非病例内容。不能诊断，不能给治疗、用药、穿刺、手术、复查周期建议，不能输出内部字段、知识库引用、原文依据。',
        false
      );
      return;
    }

    const card = await this.generatePatientView(session);
    yield* this.streamText(this.cardToText(card));
  }

  async generateDoctorPackage(session: CaseSession): Promise<ResultCardDto> {
    if (this.shouldUseDeepSeek()) {
      return this.callDeepSeekJson<ResultCardDto>(
        session,
        '请生成医生查看版资料包结果卡片。只返回 JSON，结构必须是 {"title":"医生查看版资料包","sections":[{"title":"资料来源","content":["..."]},{"title":"主诉或检查原因","content":["..."]},{"title":"病程时间线","content":["..."]},{"title":"检查资料整理","content":["..."]},{"title":"患者补充信息","content":["..."]},{"title":"已有检查资料","content":["..."]},{"title":"仍缺资料","content":["..."]},{"title":"建议向医生确认的问题","content":["..."]},{"title":"安全声明","content":["以上为资料整理，不替代医生诊断和治疗。"]}]}。医生版必须结构化，只整理真正的病例资料；忽略寒暄、问候、问你是谁、问软件怎么用等非病例内容。不能下诊断，不能给治疗、用药、穿刺、手术、复查周期建议，待确认事项只能写成问题。'
      );
    }

    return {
      title: '医生查看版资料包',
      sections: [
        {
          title: '资料来源',
          content: session.documents.map((document) => `${document.displayName}，来源类型：${document.sourceType}`)
        },
        {
          title: '主诉或检查原因',
          content: session.facts.length > 0 ? session.facts.map((fact) => `${fact.label}：${fact.content}`) : ['患者尚未补充明确检查原因。']
        },
        {
          title: '病程时间线',
          content: ['患者上传检查资料后，系统围绕检查原因、症状、既往检查和相关病史进行了多轮资料收集。']
        },
        {
          title: '检查资料整理',
          content: session.documents.map((document) => document.extractedText ?? `${document.displayName} 已记录，等待进一步文本提取。`)
        },
        {
          title: '仍缺资料',
          content: ['既往同部位检查结果、相关化验资料、医生已给出的说明仍需结合实际情况确认。']
        },
        {
          title: '建议向医生确认的问题',
          content: [
            '当前报告中的异常提示需要结合哪些病史、体格检查或原始影像信息判断？',
            '是否需要补充甲状腺功能等相关检查，请医生结合情况判断。',
            '是否需要进一步检查或随访安排，请医生结合原始影像和临床资料判断。'
          ]
        },
        {
          title: '安全声明',
          content: ['以上为资料整理，不替代医生诊断和治疗。']
        }
      ]
    };
  }

  async *streamDoctorPackage(session: CaseSession): AsyncGenerator<string> {
    if (this.shouldUseDeepSeek()) {
      yield* this.streamDeepSeekText(
        session,
        '请生成医生查看版资料包。只输出正文，不要输出 JSON。格式必须包含标题“医生查看版资料包”，并依次包含“资料来源”“主诉或检查原因”“病程时间线”“检查资料整理”“患者补充信息”“已有检查资料”“仍缺资料”“建议向医生确认的问题”“安全声明”。医生版必须结构化，只整理真正的病例资料；忽略寒暄、问候、问你是谁、问软件怎么用等非病例内容。不能下诊断，不能给治疗、用药、穿刺、手术、复查周期建议，待确认事项只能写成问题。',
        false
      );
      return;
    }

    const card = await this.generateDoctorPackage(session);
    yield* this.streamText(this.cardToText(card));
  }

  private shouldUseDeepSeek() {
    return process.env.LLM_PROVIDER === 'deepseek';
  }

  private async callDeepSeekJson<T>(session: CaseSession, task: string, options: { includeKnowledge?: boolean; temperature?: number } = {}): Promise<T> {
    const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com';
    const apiKey = process.env.LLM_API_KEY;
    const model = this.deepSeekModel();

    if (!apiKey) {
      throw new Error('LLM_API_KEY is required when LLM_PROVIDER=deepseek');
    }

    const messages: DeepSeekMessage[] = [
      {
        role: 'system',
        content: this.buildSystemContext(session, true, options.includeKnowledge ?? false)
      },
      {
        role: 'user',
        content: `${task}\n\n当前病例资料：\n${this.buildCaseContext(session)}`
      }
    ];

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(this.deepSeekRequestBody({
        model,
        messages,
        jsonOutput: true,
        temperature: options.temperature ?? 0.2
      }))
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DeepSeek request failed: ${response.status} ${body}`);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_content?: string;
        };
      }>;
    };
    const message = data.choices?.[0]?.message;
    void message?.reasoning_content;
    const content = message?.content;
    if (!content) {
      throw new Error('DeepSeek returned empty content');
    }

    return this.parseJsonContent<T>(content);
  }

  private async *streamDeepSeekText(session: CaseSession, task: string, includeKnowledge: boolean): AsyncGenerator<string> {
    const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com';
    const apiKey = process.env.LLM_API_KEY;
    const model = this.deepSeekModel();

    if (!apiKey) {
      throw new Error('LLM_API_KEY is required when LLM_PROVIDER=deepseek');
    }

    const messages: DeepSeekMessage[] = [
      {
        role: 'system',
        content: this.buildSystemContext(session, false, includeKnowledge)
      },
      {
        role: 'user',
        content: `${task}\n\n当前病例资料：\n${this.buildCaseContext(session)}`
      }
    ];

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(this.deepSeekRequestBody({
        model,
        messages,
        temperature: 0.45,
        stream: true,
        jsonOutput: false
      }))
    });

    if (!response.ok || !response.body) {
      const body = await response.text();
      throw new Error(`DeepSeek stream request failed: ${response.status} ${body}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string;
              reasoning_content?: string;
            };
          }>;
        };
        const delta = parsed.choices?.[0]?.delta;
        void delta?.reasoning_content;
        const chunk = delta?.content;
        if (chunk) {
          yield chunk;
        }
      }
    }
  }

  private deepSeekModel() {
    return process.env.LLM_MODEL ?? 'deepseek-v4-pro';
  }

  private deepSeekThinkingEnabled(model: string) {
    if (model === 'deepseek-reasoner') {
      return false;
    }
    return (process.env.LLM_THINKING_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  private deepSeekRequestBody(options: DeepSeekRequestOptions & { model: string; messages: DeepSeekMessage[] }) {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages
    };

    if (typeof options.temperature === 'number' && options.model !== 'deepseek-reasoner') {
      body.temperature = options.temperature;
    }
    if (options.stream) {
      body.stream = true;
    }
    if (options.jsonOutput) {
      body.response_format = { type: 'json_object' };
    }
    if (this.deepSeekThinkingEnabled(options.model)) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = process.env.LLM_REASONING_EFFORT ?? 'high';
    }

    return body;
  }

  private buildSystemContext(session: CaseSession, jsonOutput: boolean, includeKnowledge: boolean) {
    const context = [
      session.promptContext.systemPrompt,
      includeKnowledge ? '以下知识库仅在本会话第一次追问时注入，作为内部上下文；不得在回答中显示文件名、命中规则、引用来源或内部标签。' : '本轮不重复注入知识库文件；请基于系统提示词和当前病例上下文继续工作，不得显示内部标签。',
      jsonOutput ? '输出要求：必须是合法 JSON；不得包含 Markdown 代码块；不得输出 normal/abnormal/uncertain、Evidence Graph、原文依据、命中规则、P1/P2/P3。' : '输出要求：只输出可直接给患者看到的正文；不得包含 Markdown 代码块；不得输出 normal/abnormal/uncertain、Evidence Graph、原文依据、命中规则、P1/P2/P3。'
    ];

    if (includeKnowledge) {
      context.splice(
        2,
        0,
        session.promptContext.knowledgeFiles
          .map((file) => `# ${file.fileName}\n${file.content}`)
          .join('\n\n')
      );
    }

    return context.join('\n\n');
  }

  private buildCaseContext(session: CaseSession) {
    return JSON.stringify({
      latestUserMessage: [...session.messages].reverse().find((message) => message.role === 'user')?.content ?? '',
      documents: session.documents.map((document) => ({
        sourceType: document.sourceType,
        displayName: document.displayName,
        extractedText: document.extractedText
      })),
      patientFacts: session.facts.map((fact) => ({
        label: fact.label,
        content: fact.content
      })),
      askedQuestions: session.askedQuestions
    }, null, 2);
  }

  private parseJsonContent<T>(content: string): T {
    const cleaned = content
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    return JSON.parse(cleaned) as T;
  }

  private async *streamText(text: string): AsyncGenerator<string> {
    for (let index = 0; index < text.length; index += 12) {
      yield text.slice(index, index + 12);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private cardToText(card: ResultCardDto) {
    return [card.title, ...card.sections.flatMap((section) => [section.title, ...section.content])].join('\n');
  }
}
