import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  ChatMessageDto,
  MessageAttachmentDto,
  PackageDownloadDto,
  PatientFactDto,
  ResultCardDto,
  SessionDto,
  SessionStatus,
  SourceDocumentDto
} from '@medical-evidence/shared';
import { FollowupDecision, MockAiGateway } from './mock-ai.gateway.js';
import { PromptContext, PromptService, selectRemainingQuestions } from './prompt.service.js';
import { assertSafeText } from './safety.js';

export interface CaseSession {
  id: string;
  status: SessionStatus;
  promptContext: PromptContext;
  documents: SourceDocumentDto[];
  facts: PatientFactDto[];
  factSummaries: PatientFactDto[];
  knowledgeInjected: boolean;
  messages: ChatMessageDto[];
  askedQuestions: string[];
  askedQuestionIds: string[];
  coveredQuestionIds: string[];
  patientView?: ResultCardDto;
  doctorPackage?: ResultCardDto;
  packages: PackageDownloadDto[];
}

function now() {
  return new Date().toISOString();
}

function message(
  role: 'assistant' | 'user',
  content: string,
  kind: ChatMessageDto['kind'] = 'message',
  attachments?: MessageAttachmentDto[]
): ChatMessageDto {
  return {
    id: randomUUID(),
    role,
    content,
    kind,
    attachments,
    createdAt: now()
  };
}

export function isStopRequestText(content: string) {
  const normalized = content.trim();
  return [
    '结束访谈',
    '没有要补充的东西了',
    '没有了',
    '先到这里',
    '生成病程分析',
    '生成患者展示版',
    '生成患者版',
    '生成医生查看版资料包'
  ].some((phrase) => normalized.includes(phrase));
}

const stopHint = '如果没有再补充的或者不想继续上传了，可以告诉我没有要补充的东西了。';

@Injectable()
export class SessionsService {
  private readonly sessions = new Map<string, CaseSession>();

  constructor(
    @Inject(PromptService)
    private readonly promptService: PromptService,
    @Inject(MockAiGateway)
    private readonly aiGateway: MockAiGateway
  ) {
    for (const dir of [this.uploadDir(), this.generatedDir()]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  createSession(): SessionDto {
    const session: CaseSession = {
      id: randomUUID(),
      status: 'WAITING_FIRST_INPUT',
      promptContext: this.promptService.loadContext(),
      documents: [],
      facts: [],
      factSummaries: [],
      knowledgeInjected: false,
      messages: [
        message(
          'assistant',
          '你好，我是医检证据助手。请上传清晰报告图片或粘贴报告文字，我会整理已有资料、按优先级补充追问，并生成患者病程梳理或医生查看版资料包。请先删除姓名、手机号、身份证号、门诊号、住院号、检查号等隐私信息。'
        )
      ],
      askedQuestions: [],
      askedQuestionIds: [],
      coveredQuestionIds: [],
      packages: []
    };
    this.sessions.set(session.id, session);
    return this.toDto(session);
  }

  getSession(sessionId: string): SessionDto {
    return this.toDto(this.requireSession(sessionId));
  }

  async submitText(sessionId: string, content: string, attachmentDocumentIds: string[] = []): Promise<{ session: SessionDto; assistantMessage?: ChatMessageDto; patientView?: ResultCardDto }> {
    const session = this.requireSession(sessionId);
    session.messages.push(message('user', content, 'message', this.messageAttachmentsFromIds(session, attachmentDocumentIds)));
    const factRecorded = this.recordPatientFact(session, content);

    if (isStopRequestText(content)) {
      this.applyCoveredQuestionIds(session, await this.aiGateway.identifyCoveredQuestionIds(session, content));
      if (factRecorded) await this.refreshFactSummaries(session);
      const patientView = await this.generatePatientView(sessionId);
      return { session: this.toDto(session), patientView };
    }
    await this.refreshFactSummaries(session);

    const assistantMessage = await this.askNextQuestion(session);
    return { session: this.toDto(session), assistantMessage };
  }

  async addTextDocument(sessionId: string, text: string): Promise<{ session: SessionDto; document: SourceDocumentDto; assistantMessage: ChatMessageDto }> {
    const session = this.requireSession(sessionId);
    const document: SourceDocumentDto = {
      id: randomUUID(),
      sourceType: 'text',
      displayName: '用户粘贴报告文字',
      extractedText: text,
      createdAt: now()
    };
    session.documents.push(document);
    session.messages.push(message('user', text));
    const assistantMessage = await this.askNextQuestion(session);
    return { session: this.toDto(session), document, assistantMessage };
  }

  async addUploadedFile(sessionId: string, file?: Express.Multer.File): Promise<{ session: SessionDto; document: SourceDocumentDto; assistantMessage?: ChatMessageDto }> {
    const result = await this.addUploadedFiles(sessionId, file ? [file] : [], true);
    return {
      session: result.session,
      document: result.documents[0],
      assistantMessage: result.assistantMessage
    };
  }

  async addUploadedFiles(sessionId: string, files: Express.Multer.File[], askNext: boolean): Promise<{ session: SessionDto; documents: SourceDocumentDto[]; assistantMessage?: ChatMessageDto }> {
    const session = this.requireSession(sessionId);
    const documents: SourceDocumentDto[] = [];

    for (const file of files.length > 0 ? files : [undefined]) {
      const displayName = normalizeUploadFileName(file?.originalname);
      const storedName = safeStoredFileName(displayName);
      const normalizedFile = file ? { ...file, originalname: displayName } as Express.Multer.File : undefined;
      if (normalizedFile?.buffer) {
        writeFileSync(resolve(this.uploadDir(), `${sessionId}-${storedName}`), normalizedFile.buffer);
      }
      const sourceType = this.inferSourceType(displayName, normalizedFile?.mimetype);
      const document: SourceDocumentDto = {
        id: randomUUID(),
        sourceType,
        displayName,
        thumbnailUrl: sourceType === 'image' ? `/api/sessions/${sessionId}/files/${encodeURIComponent(displayName)}` : undefined,
        extractedText: await this.extractTextSafely(normalizedFile),
        createdAt: now()
      };
      session.documents.push(document);
      documents.push(document);
    }

    if (askNext && documents.length > 0) {
      session.messages.push(message('user', '', 'message', documents.map((document) => this.messageAttachmentFromDocument(document))));
    }

    const assistantMessage = askNext ? await this.askNextQuestion(session) : undefined;
    return { session: this.toDto(session), documents, assistantMessage };
  }

  transcribeAudio(audio?: Express.Multer.File): Promise<string> {
    return this.aiGateway.transcribeAudio(audio);
  }

  async *streamSubmitText(sessionId: string, content: string, attachmentDocumentIds: string[] = []): AsyncGenerator<string> {
    const session = this.requireSession(sessionId);
    session.messages.push(message('user', content, 'message', this.messageAttachmentsFromIds(session, attachmentDocumentIds)));
    const factRecorded = this.recordPatientFact(session, content);

    if (isStopRequestText(content)) {
      this.applyCoveredQuestionIds(session, await this.aiGateway.identifyCoveredQuestionIds(session, content));
      yield* this.streamPatientViewIntoSession(session);
      if (factRecorded) await this.refreshFactSummaries(session);
      return;
    }

    const includeKnowledge = !session.knowledgeInjected;
    const decision = await this.aiGateway.nextFollowupDecision(session, includeKnowledge);
    session.knowledgeInjected = true;
    this.applyCoveredQuestionIds(session, decision.coveredQuestionIds);

    if (decision.action === 'generate_patient_view') {
      yield* this.streamPatientViewIntoSession(session);
      await this.refreshFactSummaries(session);
      return;
    }

    const resolved = this.replyFromDecision(session, decision);
    assertSafeText(resolved.content);
    session.status = 'WAITING_USER_ANSWER';
    for await (const chunk of this.streamText(resolved.content)) {
      yield chunk;
    }
    this.recordAskedQuestion(session, resolved.questionId, resolved.content);
    session.messages.push(message('assistant', resolved.content));
    await this.refreshFactSummaries(session);
  }

  async *streamDoctorPackage(sessionId: string): AsyncGenerator<string> {
    const session = this.requireSession(sessionId);
    let contentBuffer = '';

    for await (const chunk of this.aiGateway.streamDoctorPackage(session)) {
      contentBuffer += chunk;
      yield chunk;
    }

    assertSafeText(contentBuffer);
    const doctorPackage = this.finalizeDoctorPackage(this.cardFromText(
      '医生查看版资料包',
      ['资料来源', '主诉或检查原因', '病程时间线', '检查资料整理', '患者补充信息', '已有检查资料', '仍缺资料', '安全声明'],
      contentBuffer
    ));
    this.assertSafeCard(doctorPackage);
    session.doctorPackage = doctorPackage;
    session.messages.push(message('assistant', this.cardToText(doctorPackage), 'doctor_package'));
  }

  async generatePatientView(sessionId: string): Promise<ResultCardDto> {
    const session = this.requireSession(sessionId);
    const patientView = this.finalizePatientView(session, await this.aiGateway.generatePatientView(session));
    this.assertSafeCard(patientView);
    session.patientView = patientView;
    session.status = 'COMPLETED';
    session.messages.push(message('assistant', this.cardToText(patientView), 'patient_view'));
    return patientView;
  }

  async generateDoctorPackage(sessionId: string): Promise<ResultCardDto> {
    const session = this.requireSession(sessionId);
    const doctorPackage = this.finalizeDoctorPackage(await this.aiGateway.generateDoctorPackage(session));
    this.assertSafeCard(doctorPackage);
    session.doctorPackage = doctorPackage;
    session.messages.push(message('assistant', this.cardToText(doctorPackage), 'doctor_package'));
    return doctorPackage;
  }

  registerPackage(sessionId: string, download: PackageDownloadDto) {
    const session = this.requireSession(sessionId);
    session.packages = session.packages.filter((item) => item.packageType !== download.packageType);
    session.packages.push(download);
    return this.toDto(session);
  }

  requireSession(sessionId: string): CaseSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  uploadDir() {
    return this.resolveProjectPath(process.env.UPLOAD_DIR ?? 'data/uploads');
  }

  generatedDir() {
    return this.resolveProjectPath(process.env.GENERATED_DIR ?? 'data/generated');
  }

  uploadedFilePath(sessionId: string, displayName: string) {
    return resolve(this.uploadDir(), `${sessionId}-${safeStoredFileName(normalizeUploadFileName(displayName))}`);
  }

  private resolveProjectPath(pathValue: string) {
    if (isAbsolute(pathValue)) {
      return pathValue;
    }

    const direct = resolve(process.cwd(), pathValue);
    if (existsSync(direct)) {
      return direct;
    }

    return resolve(process.cwd(), '../../', pathValue);
  }

  private async askNextQuestion(session: CaseSession): Promise<ChatMessageDto> {
    session.status = 'WAITING_USER_ANSWER';
    const includeKnowledge = !session.knowledgeInjected;
    const decision = await this.aiGateway.nextFollowupDecision(session, includeKnowledge);
    session.knowledgeInjected = true;
    this.applyCoveredQuestionIds(session, decision.coveredQuestionIds);
    if (decision.action === 'generate_patient_view') {
      await this.generatePatientView(session.id);
      return session.messages[session.messages.length - 1];
    }

    const resolved = this.replyFromDecision(session, decision);
    assertSafeText(resolved.content);
    this.recordAskedQuestion(session, resolved.questionId, resolved.content);
    const assistantMessage = message('assistant', resolved.content);
    session.messages.push(assistantMessage);
    return assistantMessage;
  }

  private replyFromDecision(session: CaseSession, decision: FollowupDecision) {
    if (decision.selectedQuestionId) {
      const selected = session.promptContext.questionBank.find((item) => item.id === decision.selectedQuestionId && !session.coveredQuestionIds.includes(item.id))
        ?? selectRemainingQuestions(session.promptContext.questionBank, session.coveredQuestionIds, 1)[0];
      if (selected) {
        return { content: `${selected.question}\n\n${stopHint}`, questionId: selected.id };
      }
    }

    return {
      content: decision.reply.trim() || '我还需要继续确认一项关键资料。',
      questionId: undefined
    };
  }

  private inferFactLabel(index: number) {
    return ['检查原因', '症状情况', '既往检查', '相关病史'][index] ?? '补充信息';
  }

  private async *streamPatientViewIntoSession(session: CaseSession): AsyncGenerator<string> {
    let contentBuffer = '';

    for await (const chunk of this.aiGateway.streamPatientView(session)) {
      contentBuffer += chunk;
      yield chunk;
    }

    assertSafeText(contentBuffer);
    const patientView = this.finalizePatientView(session, this.cardFromText(
      '患者就诊准备卡',
      ['一、报告里需要理解的关键词', '二、医生可能会追问你的信息', '三、建议向医生确认的问题', '四、就诊前建议补充的资料'],
      contentBuffer
    ));
    this.assertSafeCard(patientView);
    session.patientView = patientView;
    session.status = 'COMPLETED';
    session.messages.push(message('assistant', this.cardToText(patientView), 'patient_view'));
  }

  private messageAttachmentsFromIds(session: CaseSession, documentIds: string[]) {
    if (documentIds.length === 0) return undefined;

    const attachments = documentIds
      .map((id) => session.documents.find((document) => document.id === id))
      .filter((document): document is SourceDocumentDto => Boolean(document))
      .map((document) => this.messageAttachmentFromDocument(document));

    return attachments.length > 0 ? attachments : undefined;
  }

  private messageAttachmentFromDocument(document: SourceDocumentDto): MessageAttachmentDto {
    return {
      documentId: document.id,
      fileName: document.displayName,
      sourceType: document.sourceType,
      thumbnailUrl: document.thumbnailUrl
    };
  }

  private async extractTextSafely(file?: Express.Multer.File) {
    try {
      return await this.aiGateway.extractTextFromFile(file);
    } catch (error) {
      return `图片已上传，但 OCR 识别失败：${error instanceof Error ? error.message : '未知错误'}。可以重新上传更清晰的报告图片，或直接粘贴报告文字。`;
    }
  }

  private inferSourceType(displayName: string, mimeType?: string): SourceDocumentDto['sourceType'] {
    const lowerName = displayName.toLowerCase();
    if (lowerName.endsWith('.pdf')) return 'pdf';
    if (lowerName.endsWith('.txt') || mimeType?.startsWith('text/')) return 'text';
    if (mimeType?.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(lowerName)) return 'image';
    return 'document';
  }

  private recordPatientFact(session: CaseSession, content: string) {
    const cleaned = content
      .replace(/(没有要补充的东西了|生成医生查看版资料包|生成患者展示版|生成患者版|生成病程分析|结束访谈|先到这里|没有了)/g, '')
      .replace(/^[\s，。；;,.]+|[\s，。；;,.]+$/g, '')
      .trim();
    if (!cleaned) return false;

    session.facts.push({
      id: randomUUID(),
      label: this.inferFactLabel(session.facts.length),
      content: cleaned,
      createdAt: now()
    });
    return true;
  }

  private applyCoveredQuestionIds(session: CaseSession, questionIds: string[]) {
    const validIds = new Set(session.promptContext.questionBank.map((item) => item.id));
    session.coveredQuestionIds = Array.from(new Set([
      ...session.coveredQuestionIds,
      ...questionIds.filter((id) => validIds.has(id))
    ]));
  }

  private recordAskedQuestion(session: CaseSession, questionId: string | undefined, content: string) {
    session.askedQuestions.push(content);
    if (!questionId) return;
    session.askedQuestionIds = Array.from(new Set([...session.askedQuestionIds, questionId]));
    this.applyCoveredQuestionIds(session, [questionId]);
  }

  private remainingPatientQuestionText(session: CaseSession) {
    const remaining = selectRemainingQuestions(session.promptContext.questionBank, session.coveredQuestionIds, 5);
    return remaining.length > 0
      ? remaining.map((item) => item.question)
      : ['本轮关键病史信息已基本覆盖，医生仍可能结合现场情况继续询问。'];
  }

  private finalizePatientView(session: CaseSession, card: ResultCardDto): ResultCardDto {
    const allowedTitles = [
      '一、报告里需要理解的关键词',
      '二、医生可能会追问你的信息',
      '三、建议向医生确认的问题',
      '四、就诊前建议补充的资料'
    ];
    const sections = allowedTitles.map((title) => {
      const section = card.sections.find((item) => item.title === title);
      return { title, content: section ? [...section.content] : ['暂无明确资料。'] };
    });
    const followupSection = sections.find((section) => section.title === '二、医生可能会追问你的信息');
    if (followupSection) {
      followupSection.content = this.remainingPatientQuestionText(session);
    }
    return { ...card, sections };
  }

  private finalizeDoctorPackage(card: ResultCardDto): ResultCardDto {
    const allowedTitles = [
      '资料来源',
      '主诉或检查原因',
      '病程时间线',
      '检查资料整理',
      '患者补充信息',
      '已有检查资料',
      '仍缺资料',
      '安全声明'
    ];
    const sections = allowedTitles.map((title) => {
      const section = card.sections.find((item) => item.title === title);
      return { title, content: section ? [...section.content] : ['暂无明确资料。'] };
    });
    return { ...card, sections };
  }

  private toDto(session: CaseSession): SessionDto {
    return {
      id: session.id,
      status: session.status,
      messages: session.messages,
      documents: session.documents,
      facts: session.facts,
      factSummaries: session.factSummaries,
      patientView: session.patientView,
      doctorPackage: session.doctorPackage,
      packages: session.packages
    };
  }

  private assertSafeCard(card: ResultCardDto) {
    for (const section of card.sections) {
      for (const line of section.content) {
        assertSafeText(line);
      }
    }
  }

  private async refreshFactSummaries(session: CaseSession) {
    const summaries = await this.aiGateway.summarizePatientFacts(session);
    for (const item of summaries) {
      assertSafeText(item.content);
    }
    session.factSummaries = summaries.map((item) => ({
      id: randomUUID(),
      label: item.label,
      content: item.content,
      createdAt: now()
    }));
  }

  private cardToText(card: ResultCardDto) {
    return [card.title, ...card.sections.flatMap((section) => [section.title, ...section.content])].join('\n');
  }

  private cardFromText(title: string, headings: string[], text: string): ResultCardDto {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const sections = headings.map((heading, index) => {
      const start = lines.findIndex((line) => this.isHeadingLine(line, heading));
      const nextHeadingIndexes = headings
        .slice(index + 1)
        .map((nextHeading) => lines.findIndex((line) => this.isHeadingLine(line, nextHeading)))
        .filter((lineIndex) => lineIndex > start);
      const end = nextHeadingIndexes.length > 0 ? Math.min(...nextHeadingIndexes) : lines.length;
      const content = start >= 0
        ? lines.slice(start + 1, end).map((line) => this.cleanCardLine(line)).filter((line) => line && !this.isAnyHeadingLine(line, headings))
        : [];

      return {
        title: heading,
        content: content.length > 0 ? content : ['暂无明确资料。']
      };
    });

    const safetySection = sections.find((section) => section.title === '安全声明');
    if (safetySection && !safetySection.content.some((line) => line.includes('不替代医生诊断和治疗'))) {
      safetySection.content = ['以上为资料整理，不替代医生诊断和治疗。'];
    }

    return { title, sections };
  }

  private isHeadingLine(line: string, heading: string) {
    return this.cleanHeadingLine(line).includes(heading);
  }

  private isAnyHeadingLine(line: string, headings: string[]) {
    return headings.some((heading) => this.isHeadingLine(line, heading));
  }

  private cleanHeadingLine(line: string) {
    return line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
  }

  private cleanCardLine(line: string) {
    return line
      .replace(/^#+\s*/, '')
      .replace(/^[-*]\s*/, '')
      .replace(/^\d+[.、]\s*/, '')
      .trim();
  }

  private async *streamText(text: string): AsyncGenerator<string> {
    for (let index = 0; index < text.length; index += 12) {
      yield text.slice(index, index + 12);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export function normalizeUploadFileName(fileName?: string) {
  if (!fileName) return '上传资料';

  const utf8Decoded = Buffer.from(fileName, 'latin1').toString('utf8');
  if (countReplacementChars(utf8Decoded) < countReplacementChars(fileName)) {
    return utf8Decoded;
  }

  if (isLikelyMojibake(fileName) && countReplacementChars(utf8Decoded) === 0) {
    return utf8Decoded;
  }

  return fileName;
}

function countReplacementChars(value: string) {
  return (value.match(/\uFFFD/g) ?? []).length;
}

export function safeStoredFileName(fileName: string) {
  return fileName.replace(/[\\/:*?"<>|]/g, '_');
}

function isLikelyMojibake(value: string) {
  return /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(value)
    || /[\u0080-\u009F]/.test(value);
}
