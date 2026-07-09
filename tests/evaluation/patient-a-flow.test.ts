import { afterEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MockAiGateway } from '../../apps/api/src/modules/mock-ai.gateway.js';
import { PackageService } from '../../apps/api/src/modules/package.service.js';
import { PromptService } from '../../apps/api/src/modules/prompt.service.js';
import { CaseSession, normalizeUploadFileName, SessionsService } from '../../apps/api/src/modules/sessions.service.js';

const evaluationDir = resolve('交接文档/交接文档/04_评测集');
const evaluationImagePath = resolve(evaluationDir, '测试图片1.jpg');
const evaluationWorkbookPath = resolve(evaluationDir, '医检证据助手-连续流程评测集.xlsx');

// Source: 交接文档/交接文档/04_评测集/医检证据助手-连续流程评测集.xlsx, sheet "评测数据".
// Keep this test dependency-free; the xlsx file path is still asserted so accidental moves are caught.
const continuousFlowInputs = [
  '请从这张报告图片开始帮我整理资料。',
  '这是体检发现的，最近没有明显不舒服。以前没做过腹部彩超，也没有肝胆相关病史，还没有给医生看。',
  '没有做过肝功能，也不清楚乙肝、丙肝检查结果。以前没有同部位影像资料。',
  '没有腹痛、发热、黄疸或消化不适。先到这里，请生成患者展示版和医生查看版资料包。'
] as const;

class CapturingGateway extends MockAiGateway {
  capturedSession?: CaseSession;

  override async extractTextFromFile(): Promise<string> {
    return 'OCR识别文字：甲状腺右叶低回声结节，TI-RADS 3类。';
  }

  override async nextFollowup(session: CaseSession): Promise<string> {
    this.capturedSession = session;
    return '这次做检查的原因是什么？\n\n如果没有再补充的或者不想继续上传了，可以告诉我没有要补充的东西了。';
  }
}

class ContinuousFlowGateway extends MockAiGateway {
  private followupIndex = 0;

  override async extractTextFromFile(file?: Express.Multer.File): Promise<string> {
    expect(file?.originalname).toBe('测试图片1.jpg');
    expect(file?.buffer?.length).toBeGreaterThan(0);
    return [
      '腹部超声报告文字：',
      '肝内低回声区，肝门区淋巴结可能。',
      '脾大。',
      '左肾结构显示欠清。',
      '建议结合临床资料进一步判断。'
    ].join('\n');
  }

  override async nextFollowup(): Promise<string> {
    const replies = [
      '这次做腹部超声主要是因为什么，是体检发现、复查，还是因为肚子不舒服去查？\n\n如果没有再补充的或者不想继续上传了，可以告诉我没有要补充的东西了。',
      '如果已经做过肝功能、乙肝或丙肝相关检查，可以继续提供结果；如果没有做过，也可以直接告诉我没有。\n\n如果没有再补充的或者不想继续上传了，可以告诉我没有要补充的东西了。',
      '目前还想确认一件事：有没有腹痛、发热、黄疸、消化不适，或者医生已经给出的说明？\n\n如果没有再补充的或者不想继续上传了，可以告诉我没有要补充的东西了。'
    ];
    return replies[Math.min(this.followupIndex++, replies.length - 1)];
  }

  override async generatePatientView() {
    return {
      title: '患者版病程梳理',
      sections: [
        {
          title: '一、患者病程理解',
          content: [
            '这次资料从腹部超声报告开始，报告里有一些需要医生结合更多资料判断的提示。',
            '用户补充这是体检发现，最近没有明显不舒服，以前没有做过腹部彩超，也还没有给医生看。'
          ]
        },
        {
          title: '二、疾病关键词解释',
          content: [
            '肝内低回声：这是超声报告里描述看到的一个表现，具体代表什么需要医生结合原始影像和其他资料判断。',
            '脾大：意思是报告提示脾脏大小超出常规范围，原因需要结合病史和检查资料判断。'
          ]
        },
        {
          title: '三、建议问医生的问题',
          content: [
            '这份超声报告里的提示需要结合哪些病史、体格检查或原始影像信息判断？',
            '如果没有肝功能、乙肝或丙肝相关结果，是否需要补充相关资料，请医生结合情况判断。',
            '是否需要进一步检查或随访安排，请医生结合原始影像和临床资料判断。'
          ]
        }
      ]
    };
  }

  override async generateDoctorPackage() {
    return {
      title: '医生查看版资料包',
      sections: [
        { title: '资料来源', content: ['用户上传腹部超声报告图片，并补充体检发现、症状、既往检查和相关检查情况。'] },
        { title: '主诉或检查原因', content: ['体检发现，用户自述最近没有明显不舒服。'] },
        { title: '病程时间线', content: ['体检时发现腹部超声报告异常提示；随后补充无明显腹痛、发热、黄疸或消化不适。'] },
        { title: '检查资料整理', content: ['腹部超声报告提示肝内低回声区、肝门区淋巴结可能、脾大、左肾结构显示欠清。'] },
        { title: '患者补充信息', content: ['以前没有做过腹部彩超，没有肝胆相关病史，还没有给医生看。'] },
        { title: '已有检查资料', content: ['已提供腹部超声报告图片；未提供肝功能、乙肝或丙肝相关检查结果。'] },
        { title: '仍缺资料', content: ['肝功能、乙肝或丙肝相关结果如已做过可补充；医生已给出的说明尚未提供。'] },
        { title: '建议向医生确认的问题', content: ['当前报告中的异常提示需要结合哪些病史、体格检查或原始影像信息判断？', '是否需要进一步检查或随访安排，请医生结合原始影像和临床资料判断。'] },
        { title: '安全声明', content: ['以上为资料整理，不替代医生诊断和治疗。'] }
      ]
    };
  }
}

class TitleInAskGateway extends MockAiGateway {
  override async nextFollowupDecision() {
    return {
      action: 'ask' as const,
      reply: '患者版病程梳理\n我还不能生成最终结果，还需要确认这次检查原因。\n\n如果没有再补充的或者不想继续上传了，可以告诉我没有要补充的东西了。',
      missingCriticalInfo: ['检查原因']
    };
  }

  override async generatePatientView() {
    throw new Error('generatePatientView should not be called for action=ask');
  }
}

class GenerateActionGateway extends MockAiGateway {
  generatePatientViewCalled = false;

  override async nextFollowupDecision() {
    return {
      action: 'generate_patient_view' as const,
      reply: '',
      missingCriticalInfo: []
    };
  }

  override async generatePatientView() {
    this.generatePatientViewCalled = true;
    return {
      title: '患者版病程梳理',
      sections: [
        { title: '一、患者病程理解', content: ['已根据用户提供资料整理病程。'] },
        { title: '二、疾病关键词解释', content: ['这次资料里暂时没有需要单独解释的关键词。'] },
        { title: '三、建议问医生的问题', content: ['当前资料还需要向医生确认哪些信息？'] }
      ]
    };
  }
}

class StopBypassGateway extends GenerateActionGateway {
  override async nextFollowupDecision() {
    throw new Error('nextFollowupDecision should not be called for explicit stop');
  }
}

async function collect(generator: AsyncGenerator<string>) {
  let output = '';
  for await (const chunk of generator) {
    output += chunk;
  }
  return output;
}

function expectNoInternalFields(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(/normal|abnormal|uncertain|Evidence Graph|原文依据|命中规则|引用文档|P1|P2|P3/);
}

function expectNoUnsafeMedicalAdvice(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(/通常建议穿刺|需要穿刺|需要手术|多数为良性|恶性风险较|复查周期|用药建议|建议用药/);
}

describe('患者 A 连续流程', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('修正 multipart 上传里的中文文件名乱码', () => {
    const original = '测试报告.jpg';
    const mojibake = Buffer.from(original, 'utf8').toString('latin1');
    expect(normalizeUploadFileName(mojibake)).toBe(original);
    expect(normalizeUploadFileName(original)).toBe(original);
  });

  it('上传图片后把 OCR 文字和附件消息一起进入会话上下文', async () => {
    const gateway = new CapturingGateway();
    const sessions = new SessionsService(new PromptService(), gateway);
    const session = sessions.createSession();

    const uploaded = await sessions.addUploadedFile(session.id, {
      originalname: '甲状腺彩超.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('fake image')
    } as Express.Multer.File);

    expect(gateway.capturedSession?.documents[0]?.extractedText).toContain('OCR识别文字');
    expect(uploaded.session.messages.some((item) => item.role === 'user' && item.attachments?.[0]?.fileName === '甲状腺彩超.jpg')).toBe(true);
  });

  it('DeepSeek 深度思考开启时不把 reasoning_content 输出到前端流', async () => {
    vi.stubEnv('LLM_PROVIDER', 'deepseek');
    vi.stubEnv('LLM_BASE_URL', 'https://api.deepseek.test');
    vi.stubEnv('LLM_API_KEY', 'test-key');
    vi.stubEnv('LLM_MODEL', 'deepseek-v4-pro');
    vi.stubEnv('LLM_THINKING_ENABLED', 'true');
    vi.stubEnv('LLM_REASONING_EFFORT', 'high');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"action":"ask","reply":"请继续补充检查原因。\\n\\n如果没有再补充的或者不想继续上传了，可以告诉我没有要补充的东西了。","missingCriticalInfo":["检查原因"]}', reasoning_content: '内部追问决策推理不展示' } }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"items":[]}', reasoning_content: '内部摘要推理也不展示' } }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    vi.stubGlobal('fetch', fetchMock);

    const sessions = new SessionsService(new PromptService(), new MockAiGateway());
    const session = sessions.createSession();
    const output = await collect(sessions.streamSubmitText(session.id, '我上传了一份检查报告'));
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      thinking?: { type?: string };
      reasoning_effort?: string;
    };

    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
    expect(output).toContain('请继续补充检查原因');
    expect(output).not.toContain('内部追问决策推理');
    expect(output).not.toContain('内部摘要推理');
  });

  it('action=ask 时即使 reply 含患者版标题也不能转患者卡片', async () => {
    const sessions = new SessionsService(new PromptService(), new TitleInAskGateway());
    const session = sessions.createSession();

    const result = await sessions.submitText(session.id, '你觉得资料够了吗？');

    expect(result.patientView).toBeUndefined();
    expect(result.session.patientView).toBeUndefined();
    expect(result.assistantMessage?.kind ?? 'message').toBe('message');
    expect(result.assistantMessage?.content).toContain('患者版病程梳理');
  });

  it('action=generate_patient_view 时调用专门患者版生成流程', async () => {
    const gateway = new GenerateActionGateway();
    const sessions = new SessionsService(new PromptService(), gateway);
    const session = sessions.createSession();

    const output = await collect(sessions.streamSubmitText(session.id, '资料已经补充完整'));
    const finalSession = sessions.getSession(session.id);

    expect(gateway.generatePatientViewCalled).toBe(true);
    expect(output).toContain('患者版病程梳理');
    expect(finalSession.patientView?.title).toBe('患者版病程梳理');
  });

  it('用户明确结束访谈时绕过 action 判断直接生成患者版', async () => {
    const gateway = new StopBypassGateway();
    const sessions = new SessionsService(new PromptService(), gateway);
    const session = sessions.createSession();

    const output = await collect(sessions.streamSubmitText(session.id, '没有要补充的东西了'));
    const finalSession = sessions.getSession(session.id);

    expect(gateway.generatePatientViewCalled).toBe(true);
    expect(output).toContain('患者版病程梳理');
    expect(finalSession.patientView?.title).toBe('患者版病程梳理');
  });

  it('按连续流程评测集跑完后才生成患者展示版和医生查看版资料包', async () => {
    expect(existsSync(evaluationImagePath)).toBe(true);
    expect(existsSync(evaluationWorkbookPath)).toBe(true);

    const sessions = new SessionsService(new PromptService(), new ContinuousFlowGateway());
    const packages = new PackageService(sessions);

    const session = sessions.createSession();
    expect(session.messages[0]?.content).toContain('医检证据助手');

    const uploaded = await sessions.addUploadedFiles(session.id, [{
      originalname: '测试图片1.jpg',
      mimetype: 'image/jpeg',
      buffer: readFileSync(evaluationImagePath)
    } as Express.Multer.File], false);
    expect(uploaded.documents[0]?.displayName).toBe('测试图片1.jpg');
    expect(uploaded.documents[0]?.extractedText).toContain('腹部超声报告文字');

    const step1 = await sessions.submitText(session.id, continuousFlowInputs[0], uploaded.documents.map((document) => document.id));
    expect(step1.patientView).toBeUndefined();
    expect(step1.session.patientView).toBeUndefined();
    expect(step1.assistantMessage?.kind ?? 'message').toBe('message');
    expect(step1.assistantMessage?.content).toContain('腹部超声');
    expectNoInternalFields(step1);
    expectNoUnsafeMedicalAdvice(step1);

    const step2 = await sessions.submitText(session.id, continuousFlowInputs[1]);
    expect(step2.patientView).toBeUndefined();
    expect(step2.session.patientView).toBeUndefined();
    expect(step2.assistantMessage?.kind ?? 'message').toBe('message');
    expect(step2.assistantMessage?.content).toContain('肝功能');
    expectNoInternalFields(step2);
    expectNoUnsafeMedicalAdvice(step2);

    const step3 = await sessions.submitText(session.id, continuousFlowInputs[2]);
    expect(step3.patientView).toBeUndefined();
    expect(step3.session.patientView).toBeUndefined();
    expect(step3.assistantMessage?.kind ?? 'message').toBe('message');
    expect(step3.assistantMessage?.content).toContain('腹痛');
    expectNoInternalFields(step3);
    expectNoUnsafeMedicalAdvice(step3);

    const stopped = await sessions.submitText(session.id, continuousFlowInputs[3]);
    expect(stopped.patientView?.title).toMatch(/患者版病程梳理|患者展示版/);
    expect(stopped.patientView?.sections.map((section) => section.title)).toEqual([
      '一、患者病程理解',
      '二、疾病关键词解释',
      '三、建议问医生的问题'
    ]);
    expectNoInternalFields(stopped.patientView);
    expectNoUnsafeMedicalAdvice(stopped.patientView);

    const doctorPackage = await sessions.generateDoctorPackage(session.id);
    expect(doctorPackage.title).toBe('医生查看版资料包');
    expect(doctorPackage.sections.map((section) => section.title)).toEqual([
      '资料来源',
      '主诉或检查原因',
      '病程时间线',
      '检查资料整理',
      '患者补充信息',
      '已有检查资料',
      '仍缺资料',
      '建议向医生确认的问题',
      '安全声明'
    ]);
    expectNoInternalFields(doctorPackage);
    expectNoUnsafeMedicalAdvice(doctorPackage);

    const patientZip = await packages.createPackage(session.id, 'patient');
    const doctorZip = await packages.createPackage(session.id, 'doctor');
    expect(patientZip.fileName).toContain('患者资料包');
    expect(doctorZip.fileName).toContain('医生资料包');
    expect(new AdmZip(packages.packagePath(patientZip.fileName)).getEntries().some((entry) => entry.entryName.startsWith('原始附件/'))).toBe(true);

    const finalSession = sessions.getSession(session.id);
    expect(finalSession.packages).toHaveLength(2);
    expectNoInternalFields(finalSession);
    expectNoUnsafeMedicalAdvice(finalSession);
  });
});
