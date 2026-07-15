import React, { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Bot,
  CheckCircle2,
  ClipboardList,
  Copy,
  Database,
  FileArchive,
  FileText,
  FolderOpen,
  Image,
  Mic,
  Paperclip,
  Send,
  Upload,
  X
} from 'lucide-react';
import {
  ChatMessageDto,
  MessageAttachmentDto,
  PackageDownloadDto,
  ResultCardDto,
  SessionDto,
  SourceDocumentDto
} from '@medical-evidence/shared';
import './styles.css';

const apiBase = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';
const endInterviewText = '结束访谈';
const generatingPatientViewText = '正在生成患者病程整理...';

type StreamingCardType = 'patient' | 'doctor';
type FlowStage = 'knowledge' | 'collect' | 'generate';
type MobileDrawerType = 'flow' | 'evidence' | null;

interface StreamingCardState {
  type: StreamingCardType;
  text: string;
}

interface PendingAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

function App() {
  const [session, setSession] = useState<SessionDto | null>(null);
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [requestingVoice, setRequestingVoice] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [streamingCard, setStreamingCard] = useState<StreamingCardState | null>(null);
  const [mobileDrawer, setMobileDrawer] = useState<MobileDrawerType>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSamplesRef = useRef<Float32Array[]>([]);
  const recordingActiveRef = useRef(false);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const chatMainRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void createSession();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowSplash(false), 1500);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => () => {
    for (const item of pendingAttachmentsRef.current) {
      revokeAttachment(item);
    }
  }, []);

  useEffect(() => {
    scrollChatToBottom();
  }, [
    session?.messages.length,
    session?.messages.at(-1)?.content,
    session?.patientView,
    session?.doctorPackage,
    streamingCard?.text
  ]);

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, options);
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.json() as Promise<T>;
  }

  async function createSession() {
    setBusy(true);
    try {
      const data = await request<{ session: SessionDto }>('/api/sessions', { method: 'POST' });
      setSession(data.session);
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(content = input) {
    if (!session || (!content.trim() && pendingAttachments.length === 0)) return;
    const submittedContent = content.trim();
    const attachmentsToUpload = pendingAttachments;
    flushSync(() => {
      setInput('');
      setPendingAttachments([]);
      setBusy(true);
    });
    try {
      let currentSession = session;
      let attachmentDocumentIds: string[] = [];

      if (attachmentsToUpload.length > 0) {
        const localUserMessage = clientMessage('user', submittedContent, attachmentsToMessageAttachments(attachmentsToUpload));
        const localAssistantMessage = clientMessage('assistant', '');
        flushSync(() => {
          setSession({
            ...currentSession,
            messages: [...currentSession.messages, localUserMessage, localAssistantMessage]
          });
        });

        const uploadResult = await uploadPendingAttachments(currentSession, attachmentsToUpload, !submittedContent);
        currentSession = uploadResult.session;
        attachmentDocumentIds = (uploadResult.documents ?? []).map((document) => document.id);
        for (const item of attachmentsToUpload) revokeAttachment(item);

        if (!submittedContent) {
          setSession(currentSession);
          return;
        }
      }

      const userMessage = clientMessage('user', submittedContent, messageAttachmentsFromDocuments(currentSession, attachmentDocumentIds));
      const shouldGeneratePatientView = isStopRequestText(submittedContent);

      if (shouldGeneratePatientView) {
        const optimisticSession = {
          ...currentSession,
          messages: [...currentSession.messages, userMessage]
        };
        flushSync(() => {
          setSession(optimisticSession);
          setStreamingCard({ type: 'patient', text: generatingPatientViewText });
        });
        await nextFrame();
        await sendMessageStream(optimisticSession, submittedContent, undefined, attachmentDocumentIds, 'patient');
      } else {
        const assistantMessage = clientMessage('assistant', '');
        const optimisticSession = {
          ...currentSession,
          messages: [...currentSession.messages, userMessage, assistantMessage]
        };
        flushSync(() => {
          setSession(optimisticSession);
        });
        await nextFrame();
        await sendMessageStream(optimisticSession, submittedContent, assistantMessage.id, attachmentDocumentIds);
      }
    } catch (error) {
      setStreamingCard(null);
      setSession((prev) => prev ? replaceThinkingMessages(prev, errorToMessage(error)) : prev);
    } finally {
      setBusy(false);
    }
  }

  async function endInterview() {
    if (busy || transcribing || !session) return;
    await sendMessage(endInterviewText);
  }

  async function uploadPendingAttachments(currentSession: SessionDto, attachments: PendingAttachment[], askNext: boolean) {
    const formData = new FormData();
    for (const item of attachments) {
      formData.append('files', item.file);
    }
    formData.append('askNext', String(askNext));
    return request<{ session: SessionDto; documents: SourceDocumentDto[] }>(`/api/sessions/${currentSession.id}/files/batch`, {
      method: 'POST',
      body: formData
    });
  }

  async function sendMessageStream(
    currentSession: SessionDto,
    content: string,
    assistantMessageId: string | undefined,
    attachmentDocumentIds: string[] = [],
    streamCardType?: StreamingCardType
  ) {
    const response = await fetch(`${apiBase}/api/sessions/${currentSession.id}/messages/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, attachmentDocumentIds })
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    if (!response.body) {
      throw new Error('当前浏览器不支持流式读取。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let assistantContent = '';
    let displayedContent = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      assistantContent += decoder.decode(value, { stream: true });
      displayedContent = await typeStreamOutput(assistantMessageId, displayedContent, assistantContent, streamCardType);
    }

    assistantContent += decoder.decode();
    displayedContent = await typeStreamOutput(assistantMessageId, displayedContent, assistantContent, streamCardType);

    const data = await request<{ session: SessionDto }>(`/api/sessions/${currentSession.id}`);
    setSession(data.session);
    if (streamCardType) setStreamingCard(null);
  }

  async function streamEndpointToMessage(
    currentSession: SessionDto,
    endpoint: string,
    assistantMessageId: string | undefined,
    options: RequestInit = { method: 'POST' },
    streamCardType?: StreamingCardType
  ) {
    const response = await fetch(`${apiBase}${endpoint}`, options);
    if (!response.ok) {
      throw new Error(await response.text());
    }
    if (!response.body) {
      throw new Error('当前浏览器不支持流式读取。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let assistantContent = '';
    let displayedContent = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      assistantContent += decoder.decode(value, { stream: true });
      displayedContent = await typeStreamOutput(assistantMessageId, displayedContent, assistantContent, streamCardType);
    }

    assistantContent += decoder.decode();
    await typeStreamOutput(assistantMessageId, displayedContent, assistantContent, streamCardType);

    const data = await request<{ session: SessionDto }>(`/api/sessions/${currentSession.id}`);
    setSession(data.session);
    if (streamCardType) setStreamingCard(null);
  }

  async function typeStreamOutput(messageId: string | undefined, from: string, to: string, streamCardType?: StreamingCardType) {
    if (streamCardType) {
      return typeTextToStreamingCard(streamCardType, from, to);
    }
    if (!messageId) return to;
    return typeTextToMessage(messageId, from, to);
  }

  async function typeTextToStreamingCard(type: StreamingCardType, from: string, to: string) {
    let displayed = from;
    while (displayed.length < to.length) {
      displayed = to.slice(0, Math.min(displayed.length + 2, to.length));
      flushSync(() => {
        setStreamingCard({ type, text: displayed });
      });
      scrollChatToBottom();
      await nextFrame();
    }
    return displayed;
  }

  async function typeTextToMessage(messageId: string, from: string, to: string) {
    let displayed = from;
    while (displayed.length < to.length) {
      displayed = to.slice(0, Math.min(displayed.length + 2, to.length));
      flushSync(() => {
        setSession((prev) => prev ? updateMessageContent(prev, messageId, displayed) : prev);
      });
      scrollChatToBottom();
      await nextFrame();
    }
    return displayed;
  }

  function scrollChatToBottom() {
    const element = chatMainRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
  }

  function addPendingFiles(files: FileList | File[]) {
    const incomingFiles = Array.from(files);
    setPendingAttachments((prev) => {
      const seen = new Set(prev.map((item) => fileSignature(item.file)));
      const nextItems: PendingAttachment[] = [];

      for (const file of incomingFiles) {
        const signature = fileSignature(file);
        if (seen.has(signature)) continue;
        seen.add(signature);
        nextItems.push({
          id: window.crypto?.randomUUID?.() ?? `file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          file,
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
        });
      }

      return [...prev, ...nextItems];
    });
    setUploadOpen(false);
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) revokeAttachment(target);
      return prev.filter((item) => item.id !== id);
    });
  }

  function clearPendingAttachments(items: PendingAttachment[]) {
    for (const item of items) {
      revokeAttachment(item);
    }
    setPendingAttachments((prev) => prev.filter((item) => !items.some((removed) => removed.id === item.id)));
  }

  async function toggleVoice() {
    if (!session) {
      setVoiceError('当前服务还没有连接成功，请确认本地 API 已启动后再使用语音输入。');
      return;
    }
    setVoiceError('');

    if (recording) {
      recordingActiveRef.current = false;
      await finishVoiceRecording();
      return;
    }

    const mediaDevices = globalThis.navigator?.mediaDevices;
    const AudioContextCtor = window.AudioContext;
    if (!mediaDevices?.getUserMedia || !AudioContextCtor) {
      setVoiceError('当前浏览器不支持语音录入，请直接输入文字。');
      return;
    }

    setRequestingVoice(true);
    try {
      const stream = await requestMicrophoneStream(mediaDevices);
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      audioSamplesRef.current = [];
      mediaStreamRef.current = stream;
      audioContextRef.current = audioContext;
      audioSourceRef.current = source;
      audioProcessorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (recordingActiveRef.current) {
          audioSamplesRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      recordingActiveRef.current = true;
      setRecording(true);
    } catch (error) {
      cleanupVoiceRecorder();
      setVoiceError(error instanceof Error && error.message === 'microphone-permission-timeout'
        ? '浏览器暂未返回麦克风权限结果，请检查地址栏或系统麦克风权限后重试。'
        : '没有获取到麦克风权限，请允许浏览器使用麦克风后重试。');
    } finally {
      setRequestingVoice(false);
    }
  }

  async function finishVoiceRecording() {
    setRecording(false);
    setTranscribing(true);
    try {
      const sampleRate = audioContextRef.current?.sampleRate ?? 48000;
      const blob = encodeWav(resampleTo16k(mergeAudioSamples(audioSamplesRef.current), sampleRate), 16000);
      if (blob.size === 0) {
        setVoiceError('没有录到声音，请重新录音或直接输入文字。');
        return;
      }

      const formData = new FormData();
      formData.append('audio', blob, `voice-${Date.now()}.wav`);
      const data = await request<{ transcript: string }>(`/api/sessions/${session!.id}/audio`, {
        method: 'POST',
        body: formData
      });
      if (!data.transcript.trim()) {
        setVoiceError('语音转文字没有识别到内容，请重新录音或直接输入文字。');
        return;
      }

      setInput((prev) => [prev, data.transcript].filter(Boolean).join(' '));
    } catch {
      setVoiceError('语音转文字暂时失败。你可以重新录音，或直接输入文字补充。');
    } finally {
      cleanupVoiceRecorder();
      setTranscribing(false);
    }
  }

  function cleanupVoiceRecorder() {
    recordingActiveRef.current = false;
    audioProcessorRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    void audioContextRef.current?.close();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    audioContextRef.current = null;
    audioSourceRef.current = null;
    audioProcessorRef.current = null;
    audioSamplesRef.current = [];
  }

  async function generateDoctorPackage() {
    if (!session) return;
    setBusy(true);
    try {
      flushSync(() => {
        setStreamingCard({ type: 'doctor', text: '正在生成医生查看版资料包...' });
      });
      await nextFrame();
      await streamEndpointToMessage(session, `/api/sessions/${session.id}/generate-doctor-package/stream`, undefined, { method: 'POST' }, 'doctor');
    } finally {
      setBusy(false);
    }
  }

  async function createPackage(type: 'patient' | 'doctor') {
    if (!session) return;
    const download = await request<PackageDownloadDto>(`/api/sessions/${session.id}/packages/${type}`, { method: 'POST' });
    window.location.href = `${apiBase}${download.downloadUrl}`;
  }

  const messages = session?.messages ?? [];
  const showEmpty = messages.length <= 1 && !session?.documents.length;
  const visibleMessages = showEmpty ? [] : messages.filter((item, index) => index > 0 && (!item.kind || item.kind === 'message'));
  const flowStage = currentFlowStage(session, streamingCard);

  return (
    <main
      className={`app ${uploadOpen ? 'is-blurred' : ''}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (uploadOpen) return;
        if (event.dataTransfer.files.length > 0) addPendingFiles(event.dataTransfer.files);
      }}
    >
      <ProcessRail stage={flowStage} />
      <section className="chat-shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark">医</div>
            <div>
              <div className="brand-title">医检证据助手</div>
            </div>
          </div>
          <div className="top-status"><span />知识库已注入 · 安全边界已启用</div>
          <div className="mobile-panel-actions">
            <button onClick={() => setMobileDrawer('flow')}><ClipboardList size={16} />流程</button>
            <button onClick={() => setMobileDrawer('evidence')}><FolderOpen size={16} />资料</button>
          </div>
        </header>
        <div className="chat-main" ref={chatMainRef}>
          {showEmpty ? <Welcome onPreset={setInput} /> : <MessageList messages={visibleMessages} />}
          {session?.patientView && (
            <ResultCard
              card={session.patientView}
              actions={[
                { label: '复制患者版', icon: <Copy size={16} />, onClick: () => void navigator.clipboard.writeText(cardText(session.patientView!)) },
                { label: '下载患者资料包', icon: <FileArchive size={16} />, onClick: () => void createPackage('patient') },
                { label: '生成医生查看版', icon: <FileText size={16} />, onClick: () => void generateDoctorPackage() }
              ]}
            />
          )}
          {streamingCard?.type === 'patient' && (
            <ResultCard card={streamingCardToCard(streamingCard)} actions={[]} isStreaming />
          )}
          {streamingCard?.type === 'doctor' && (
            <ResultCard card={streamingCardToCard(streamingCard)} actions={[]} isStreaming />
          )}
          {session?.doctorPackage && (
            <ResultCard
              card={session.doctorPackage}
              actions={[
                { label: '复制医生版', icon: <Copy size={16} />, onClick: () => void navigator.clipboard.writeText(cardText(session.doctorPackage!)) },
                { label: '下载医生资料包', icon: <FileArchive size={16} />, onClick: () => void createPackage('doctor') }
              ]}
            />
          )}
        </div>
        <Composer
          input={input}
          setInput={setInput}
          onSend={() => void sendMessage()}
          onEndInterview={() => void endInterview()}
          onOpenUpload={() => setUploadOpen(true)}
          onToggleVoice={() => void toggleVoice()}
          pendingAttachments={pendingAttachments}
          onRemoveAttachment={removePendingAttachment}
          recording={recording}
          requestingVoice={requestingVoice}
          transcribing={transcribing}
          voiceError={voiceError}
          disabled={busy || transcribing}
        />
      </section>
      <EvidencePanel documents={session?.documents ?? []} />
      {mobileDrawer && (
        <MobileDrawer
          title={mobileDrawer === 'flow' ? '流程状态' : '当前已收集资料'}
          onClose={() => setMobileDrawer(null)}
        >
          {mobileDrawer === 'flow'
            ? <ProcessRail stage={flowStage} mobile />
            : <EvidencePanel documents={session?.documents ?? []} mobile />}
        </MobileDrawer>
      )}
      {uploadOpen && (
        <UploadModal
          onClose={() => setUploadOpen(false)}
          onSelect={() => fileInputRef.current?.click()}
          onDropFile={(files) => addPendingFiles(files)}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden-input"
        multiple
        accept="image/*,.pdf,.doc,.docx,.txt"
        onChange={(event) => {
          if (event.target.files?.length) addPendingFiles(event.target.files);
          event.target.value = '';
        }}
      />
      {showSplash && (
        <div className="splash-overlay">
          <div className="splash-card">
            <div className="splash-mark">医</div>
            <strong>欢迎使用医检证据助手</strong>
          </div>
        </div>
      )}
    </main>
  );
}

function currentFlowStage(session: SessionDto | null, streamingCard: StreamingCardState | null): FlowStage {
  if (session?.patientView || session?.doctorPackage || streamingCard) return 'generate';
  if ((session?.documents.length ?? 0) > 0 || (session?.messages.some((item) => item.role === 'user') ?? false)) return 'collect';
  return 'knowledge';
}

function ProcessRail({ stage, mobile = false }: { stage: FlowStage; mobile?: boolean }) {
  const steps: Array<{ key: FlowStage; title: string; detail: string; icon: React.ReactNode }> = [
    { key: 'knowledge', title: '初始化知识库', detail: '载入提示词、知识库和安全边界', icon: <Database size={18} /> },
    { key: 'collect', title: '多轮收集资料', detail: '围绕报告和病程逐步追问', icon: <ClipboardList size={18} /> },
    { key: 'generate', title: '生成资料卡片', detail: '输出患者版和医生查看版', icon: <CheckCircle2 size={18} /> }
  ];
  const activeIndex = steps.findIndex((item) => item.key === stage);

  return (
    <aside className={`process-rail ${mobile ? 'mobile' : ''}`}>
      <div className="process-header">
        <span>流程</span>
        <strong>{activeIndex + 1}/3</strong>
      </div>
      <div className="process-steps">
        {steps.map((item, index) => {
          const isActive = item.key === stage;
          const isDone = index < activeIndex;
          return (
            <div key={item.key} className={`process-step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}>
              <div className="process-index">{isDone ? <CheckCircle2 size={15} /> : index + 1}</div>
              <div className="process-copy">
                <div>{item.icon}<strong>{item.title}</strong></div>
                <p>{item.detail}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="process-note">您可以继续补充资料，也可以结束访谈生成卡片。</div>
    </aside>
  );
}

function Welcome({ onPreset }: { onPreset: (value: string) => void }) {
  return (
    <div className="welcome">
      <div className="avatar"><Bot size={34} /></div>
      <h1>你好，我是医检证据助手</h1>
      <p>
        你好，我是医检证据助手。请上传清晰报告图片或粘贴报告文字，我会整理已有资料、按优先级补充追问，并生成患者病程梳理或医生查看版资料包。请先删除姓名、手机号、身份证号、门诊号、住院号、检查号等隐私信息。
      </p>
      <div className="preset-row">
        {['帮我整理这份彩超报告', '帮我看看还缺哪些就诊资料', '生成医生查看版资料包'].map((item) => (
          <button key={item} onClick={() => onPreset(item)}>{item}</button>
        ))}
      </div>
    </div>
  );
}

function MessageList({ messages }: { messages: ChatMessageDto[] }) {
  return (
    <div className="message-list">
      {messages.map((item) => {
        const isThinking = item.role === 'assistant' && !item.content.trim();
        return (
          <article key={item.id} className={`message ${item.role} ${isThinking ? 'thinking' : ''}`}>
            <div className="message-role">{item.role === 'assistant' ? '医检证据助手' : '我'}</div>
            {item.attachments && item.attachments.length > 0 && (
              <div className="message-attachments">
                {item.attachments.map((attachment, index) => (
                  <MessageAttachment key={`${attachment.documentId ?? attachment.fileName}-${index}`} attachment={attachment} />
                ))}
              </div>
            )}
            {(isThinking || item.content.trim()) && (
              <div className="message-content">{isThinking ? '医检证据助手正在思考' : item.content}</div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function MessageAttachment({ attachment }: { attachment: MessageAttachmentDto }) {
  const isImage = attachment.sourceType === 'image';
  const isPdf = attachment.sourceType === 'pdf';
  return (
    <div className="message-file">
      <div className={`message-file-thumb ${isPdf ? 'pdf' : ''}`}>
        {isImage && attachment.thumbnailUrl
          ? <img src={assetUrl(attachment.thumbnailUrl)} alt="" />
          : isPdf
            ? 'PDF'
            : <FileText size={18} />}
      </div>
      <div className="message-file-meta">
        <strong>{attachment.fileName}</strong>
        <span>{attachmentTypeText(attachment.sourceType)}</span>
      </div>
    </div>
  );
}

function Composer(props: {
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  onEndInterview: () => void;
  onOpenUpload: () => void;
  onToggleVoice: () => void;
  pendingAttachments: PendingAttachment[];
  onRemoveAttachment: (id: string) => void;
  recording: boolean;
  requestingVoice: boolean;
  transcribing: boolean;
  voiceError: string;
  disabled: boolean;
}) {
  return (
    <footer className="composer">
      <div className="composer-actions">
        <button title="上传附件" onClick={props.onOpenUpload} disabled={props.disabled}><Paperclip size={18} /></button>
        <button className="end-interview" onClick={props.onEndInterview} disabled={props.disabled}>结束访谈</button>
        <div className="composer-body">
          {props.pendingAttachments.length > 0 && (
            <div className="attachment-strip">
              {props.pendingAttachments.map((item) => (
                <AttachmentChip key={item.id} item={item} onRemove={() => props.onRemoveAttachment(item.id)} />
              ))}
            </div>
          )}
          <textarea
            value={props.input}
            placeholder={props.pendingAttachments.length > 0 ? '继续输入补充信息，或上传更多资料...' : '上传报告图片，或粘贴报告文字/补充信息'}
            onChange={(event) => props.setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                props.onSend();
              }
            }}
          />
          {(props.requestingVoice || props.recording || props.transcribing || props.voiceError) && (
            <div className="composer-hint">
              {props.requestingVoice && <span className="recording-text">正在请求麦克风权限...</span>}
              {props.recording && <span className="recording-text">语音转文字正在运行</span>}
              {props.transcribing && <span className="recording-text">正在转写语音...</span>}
              {props.voiceError && <span className="voice-error">{props.voiceError}</span>}
            </div>
          )}
        </div>
        <button title="语音输入" className={`voice ${props.recording || props.requestingVoice ? 'active' : ''}`} onClick={props.onToggleVoice} disabled={(props.disabled || props.requestingVoice) && !props.recording}><Mic size={18} /></button>
        <button className="send" onClick={props.onSend} disabled={props.disabled || (!props.input.trim() && props.pendingAttachments.length === 0)}><Send size={18} /></button>
      </div>
    </footer>
  );
}

function AttachmentChip({ item, onRemove }: { item: PendingAttachment; onRemove: () => void }) {
  const isPdf = item.file.name.toLowerCase().endsWith('.pdf');
  return (
    <div className="file-chip">
      <div className={`file-thumb ${isPdf ? 'pdf' : ''}`}>
        {item.previewUrl ? <img src={item.previewUrl} alt="" /> : isPdf ? 'PDF' : <FileText size={16} />}
      </div>
      <div className="file-meta">
        <div className="file-name">{item.file.name}</div>
        <div className="file-size">{formatFileSize(item.file.size)}</div>
      </div>
      <button className="file-remove" title="移除附件" onClick={onRemove}><X size={14} /></button>
    </div>
  );
}

function EvidencePanel({ documents, mobile = false }: { documents: SourceDocumentDto[]; mobile?: boolean }) {
  return (
    <aside className={`evidence-panel ${mobile ? 'mobile' : ''}`}>
      <div className="panel-header">
        <h2>当前已收集资料 <span>ⓘ</span></h2>
      </div>
      <div className="panel-section-title"><h3>已上传资料</h3><strong>{documents.length}</strong></div>
      {documents.length === 0 ? <p className="empty">暂无上传资料</p> : documents.map((document) => (
        <div className="evidence-item" key={document.id}>
          <div className={`side-file-icon ${document.sourceType === 'pdf' ? 'pdf' : ''}`}>
            {document.sourceType === 'image' ? <Image size={16} /> : document.sourceType === 'pdf' ? 'PDF' : <FileText size={16} />}
          </div>
          <div>
            <strong>{document.displayName}</strong>
            <span>{documentStatus(document)}</span>
          </div>
        </div>
      ))}
    </aside>
  );
}

function MobileDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <section className="drawer-panel" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-header">
          <strong>{title}</strong>
          <button onClick={onClose}><X size={18} /></button>
        </header>
        <div className="drawer-body">{children}</div>
      </section>
    </div>
  );
}

function ResultCard(props: {
  card: ResultCardDto;
  actions: Array<{ label: string; icon: React.ReactNode; onClick: () => void }>;
  isStreaming?: boolean;
}) {
  return (
    <section className={`result-card ${props.isStreaming ? 'streaming' : ''}`}>
      <h2>{props.card.title}</h2>
      {props.card.sections.map((section) => (
        <div key={section.title} className="result-section">
          <h3>{section.title}</h3>
          {section.content.map((line) => <p key={line}>{line}</p>)}
        </div>
      ))}
      {props.actions.length > 0 && (
        <div className="result-actions">
          {props.actions.map((action) => (
            <button key={action.label} onClick={action.onClick}>{action.icon}{action.label}</button>
          ))}
        </div>
      )}
    </section>
  );
}

function UploadModal({ onClose, onSelect, onDropFile }: { onClose: () => void; onSelect: () => void; onDropFile: (files: FileList) => void }) {
  return (
    <div
      className="upload-overlay"
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button className="modal-close" onClick={onClose}><X size={18} /></button>
      <div
        className="upload-box"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer.files.length > 0) onDropFile(event.dataTransfer.files);
        }}
      >
        <Upload size={34} />
        <p>将您的图片/检查报告单拖拽至此或点击此处上传文件</p>
      </div>
    </div>
  );
}

function cardText(card: ResultCardDto) {
  return [card.title, ...card.sections.flatMap((section) => [section.title, ...section.content])].join('\n');
}

function streamingCardToCard(state: StreamingCardState): ResultCardDto {
  if (state.type === 'patient') {
    return textToCardDraft('患者就诊准备卡', ['一、报告里需要理解的关键词', '二、医生可能会追问你的信息', '三、建议向医生确认的问题', '四、就诊前建议补充的资料'], state.text);
  }
  return textToCardDraft(
    '医生查看版资料包',
    ['资料来源', '主诉或检查原因', '病程时间线', '检查资料整理', '患者补充信息', '已有检查资料', '仍缺资料', '安全声明'],
    stripDoctorConfirmationSection(state.text)
  );
}

function stripDoctorConfirmationSection(text: string) {
  return text.replace(
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:八、)?建议向医生(?:询问|确认)的问题[\s\S]*?(?=\n\s*(?:#{1,6}\s*)?(?:八、|九、)?安全声明|$)/g,
    '\n'
  );
}

function textToCardDraft(title: string, headings: string[], text: string): ResultCardDto {
  const meaningfulText = text.trim();
  if (!meaningfulText || meaningfulText === generatingPatientViewText || meaningfulText === '正在生成医生查看版资料包...') {
    return {
      title,
      sections: [{ title: '生成中', content: [meaningfulText || '正在生成...'] }]
    };
  }

  const lines = meaningfulText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sections = headings.map((heading, index) => {
    const start = lines.findIndex((line) => cleanHeadingLine(line).includes(heading));
    const nextIndexes = headings
      .slice(index + 1)
      .map((nextHeading) => lines.findIndex((line) => cleanHeadingLine(line).includes(nextHeading)))
      .filter((lineIndex) => lineIndex > start);
    const end = nextIndexes.length > 0 ? Math.min(...nextIndexes) : lines.length;
    const content = start >= 0
      ? lines.slice(start + 1, end).map(cleanCardLine).filter((line) => line && !headings.some((item) => cleanHeadingLine(line).includes(item)))
      : [];
    return { title: heading, content: content.length > 0 ? content : ['正在生成...'] };
  });

  if (sections.every((section) => section.content[0] === '正在生成...')) {
    return { title, sections: [{ title: '生成中', content: [meaningfulText] }] };
  }

  return { title, sections };
}

function cleanHeadingLine(line: string) {
  return line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
}

function cleanCardLine(line: string) {
  return line
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^\d+[.、]\s*/, '')
    .trim();
}

function revokeAttachment(item: PendingAttachment) {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function documentStatus(document: SourceDocumentDto) {
  if (document.sourceType === 'image') {
    if (!document.extractedText) return '图片 · 等待识别';
    if (isOcrUnavailableText(document.extractedText)) return '图片 · 未启用真实 OCR';
    if (isOcrFailedText(document.extractedText)) return '图片 · OCR 识别失败';
    return '图片 · 已识别文字';
  }
  if (document.sourceType === 'pdf') return document.extractedText ? 'PDF · 已加入资料' : 'PDF · 等待识别';
  if (document.sourceType === 'text') return '文字资料 · 已加入资料';
  return '文件资料 · 已加入资料';
}

function fileSignature(file: File) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function isOcrUnavailableText(text: string) {
  return text.startsWith('图片已上传，当前未启用真实 OCR');
}

function isOcrFailedText(text: string) {
  return text.startsWith('图片已上传，但 OCR 识别失败');
}

function attachmentsToMessageAttachments(items: PendingAttachment[]): MessageAttachmentDto[] {
  return items.map((item) => ({
    fileName: item.file.name,
    sourceType: inferAttachmentSourceType(item.file),
    thumbnailUrl: item.previewUrl
  }));
}

function messageAttachmentsFromDocuments(session: SessionDto, documentIds: string[]): MessageAttachmentDto[] | undefined {
  if (documentIds.length === 0) return undefined;
  const attachments = documentIds
    .map((id) => session.documents.find((document) => document.id === id))
    .filter((document): document is SourceDocumentDto => Boolean(document))
    .map((document) => ({
      documentId: document.id,
      fileName: document.displayName,
      sourceType: document.sourceType,
      thumbnailUrl: document.thumbnailUrl
    }));
  return attachments.length > 0 ? attachments : undefined;
}

function inferAttachmentSourceType(file: File): SourceDocumentDto['sourceType'] {
  const lowerName = file.name.toLowerCase();
  if (file.type.startsWith('image/')) return 'image';
  if (lowerName.endsWith('.pdf')) return 'pdf';
  if (file.type.startsWith('text/') || lowerName.endsWith('.txt')) return 'text';
  return 'document';
}

function attachmentTypeText(sourceType: SourceDocumentDto['sourceType']) {
  if (sourceType === 'image') return '图片';
  if (sourceType === 'pdf') return 'PDF';
  if (sourceType === 'text') return '文字资料';
  return '附件';
}

function assetUrl(url: string) {
  if (/^https?:\/\//i.test(url) || url.startsWith('blob:')) return url;
  return `${apiBase}${url}`;
}

function isStopRequestText(content: string) {
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

function clientMessage(role: ChatMessageDto['role'], content: string, attachments?: MessageAttachmentDto[]): ChatMessageDto {
  const id = window.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    role,
    content,
    kind: 'message',
    attachments,
    createdAt: new Date().toISOString()
  };
}

function updateMessageContent(session: SessionDto, messageId: string, content: string): SessionDto {
  return {
    ...session,
    messages: session.messages.map((message) => message.id === messageId ? { ...message, content } : message)
  };
}

function replaceThinkingMessages(session: SessionDto, content: string): SessionDto {
  let replaced = false;
  const messages = session.messages.map((message) => {
    if (message.role === 'assistant' && !message.content.trim()) {
      replaced = true;
      return { ...message, content };
    }
    return message;
  });

  return {
    ...session,
    messages: replaced ? messages : [...messages, clientMessage('assistant', content)]
  };
}

function errorToMessage(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|Load failed/i.test(rawMessage)) {
    return '上传失败：当前网页连接不到本地后端服务。请确认 API 服务已启动后重试。';
  }
  return `上传或生成失败：${rawMessage || '未知错误，请稍后重试。'}`;
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function requestMicrophoneStream(mediaDevices: MediaDevices) {
  return new Promise<MediaStream>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      reject(new Error('microphone-permission-timeout'));
    }, 12000);

    mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        window.clearTimeout(timer);
        if (settled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        settled = true;
        resolve(stream);
      })
      .catch((error: unknown) => {
        window.clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
  });
}

function mergeAudioSamples(chunks: Float32Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resampleTo16k(input: Float32Array, sourceRate: number) {
  if (sourceRate === 16000) return input;
  const ratio = sourceRate / 16000;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, input.length - 1);
    const weight = sourceIndex - before;
    output[i] = input[before] * (1 - weight) + input[after] * weight;
  }
  return output;
}

function encodeWav(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

createRoot(document.getElementById('root')!).render(<App />);
