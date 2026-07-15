import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const apiBase = (process.env.REAL_E2E_API_BASE ?? 'http://127.0.0.1:3001/api').replace(/\/$/, '');
const imagePath = resolve('交接文档/交接文档/04_评测集/测试图片1.jpg');
const inputs = [
  '请从这张报告图片开始帮我整理资料。',
  '这是体检发现的，最近没有明显不舒服。以前没做过腹部彩超，也没有肝胆相关病史，还没有给医生看。',
  '没有做过肝功能，也不清楚乙肝、丙肝检查结果。以前没有同部位影像资料。',
  '没有腹痛、发热、黄疸或消化不适。先到这里，请生成患者展示版和医生查看版资料包。'
];

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  assert.equal(response.ok, true, `${path} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function streamRequest(path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${path} returned ${response.status}: ${text}`);
  assert.doesNotMatch(text, /\[生成失败\]/, `${path} reported a generation failure`);
  return text;
}

await jsonRequest('/health');
const created = await jsonRequest('/sessions', { method: 'POST' });
const sessionId = created.session?.id;
assert.ok(sessionId, '创建会话未返回 session id');

const image = await readFile(imagePath);
const form = new FormData();
form.append('files', new Blob([image], { type: 'image/jpeg' }), '测试图片1.jpg');
form.append('askNext', 'false');
const uploaded = await jsonRequest(`/sessions/${sessionId}/files/batch`, { method: 'POST', body: form });
const document = uploaded.documents?.[0];
assert.equal(document?.sourceType, 'image');
assert.ok(document?.extractedText?.length > 40, 'OCR 返回文字过短');
assert.doesNotMatch(document.extractedText, /未启用真实 OCR|OCR 识别失败|mock/i);

for (let index = 0; index < inputs.length - 1; index += 1) {
  const attachmentDocumentIds = index === 0 ? [document.id] : [];
  const reply = await streamRequest(`/sessions/${sessionId}/messages/stream`, {
    content: inputs[index],
    attachmentDocumentIds
  });
  assert.ok(reply.trim().length > 0, `第 ${index + 1} 轮 DeepSeek 未返回内容`);
  const current = await jsonRequest(`/sessions/${sessionId}`);
  assert.equal(current.session?.patientView, undefined, `第 ${index + 1} 轮过早生成患者版`);
}

await streamRequest(`/sessions/${sessionId}/messages/stream`, { content: inputs.at(-1) });
let current = await jsonRequest(`/sessions/${sessionId}`);
const patientView = current.session?.patientView;
assert.deepEqual(patientView?.sections?.map((section) => section.title), [
  '一、报告里需要理解的关键词',
  '二、医生可能会追问你的信息',
  '三、建议向医生确认的问题',
  '四、就诊前建议补充的资料'
]);
assert.doesNotMatch(JSON.stringify(patientView), /这份资料目前说明了什么|患者病程理解/);

await streamRequest(`/sessions/${sessionId}/generate-doctor-package/stream`);
current = await jsonRequest(`/sessions/${sessionId}`);
const doctorPackage = current.session?.doctorPackage;
assert.deepEqual(doctorPackage?.sections?.map((section) => section.title), [
  '资料来源',
  '主诉或检查原因',
  '病程时间线',
  '检查资料整理',
  '患者补充信息',
  '已有检查资料',
  '仍缺资料',
  '安全声明'
]);
assert.doesNotMatch(JSON.stringify(doctorPackage), /建议向医生(?:询问|确认)的问题/);

const patientZip = await jsonRequest(`/sessions/${sessionId}/packages/patient`, { method: 'POST' });
const doctorZip = await jsonRequest(`/sessions/${sessionId}/packages/doctor`, { method: 'POST' });
for (const item of [patientZip, doctorZip]) {
  const response = await fetch(`${apiBase}${item.downloadUrl.replace(/^\/api/, '')}`);
  assert.equal(response.ok, true, `下载 ${item.fileName} 失败`);
  assert.ok((await response.arrayBuffer()).byteLength > 100, `${item.fileName} 内容过短`);
}

console.log(JSON.stringify({
  status: 'passed',
  sessionId,
  ocrCharacters: document.extractedText.length,
  patientSections: patientView.sections.length,
  doctorSections: doctorPackage.sections.length,
  packages: [patientZip.fileName, doctorZip.fileName]
}, null, 2));
