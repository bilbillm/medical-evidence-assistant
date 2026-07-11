import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface PromptContext {
  systemPrompt: string;
  questionBank: QuestionBankItem[];
  knowledgeFiles: Array<{
    fileName: string;
    content: string;
    updatedAt: string;
  }>;
}

export interface QuestionBankItem {
  id: string;
  category: 'present_illness' | 'past_history';
  priority: 'P1' | 'P2' | 'P3';
  question: string;
}

const defaultPromptFile = '交接文档/交接文档/02_DEAP配置文案/deap_persona_integrated_prompt.md';
const defaultKnowledgeDir = '交接文档/交接文档/03_知识库文件';
const knowledgeFileNames = [
  'basic_question_bank.md',
  'diagnosis_gap_rules.md',
  'exam_body_part_table.md',
  'normal_abnormal_rules.md',
  'summary_templates.md'
];

const questionIdPattern = /^(hpi|pmh)_[a-z_]+$/;

export function parseQuestionBank(content: string): QuestionBankItem[] {
  const questions = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\|\s*(hpi|pmh)_/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .map(([id, category, priority, question]) => ({ id, category, priority, question }))
    .filter((item): item is QuestionBankItem =>
      questionIdPattern.test(item.id)
      && (item.category === 'present_illness' || item.category === 'past_history')
      && (item.priority === 'P1' || item.priority === 'P2' || item.priority === 'P3')
      && item.question.length > 0
    );

  const uniqueIds = new Set(questions.map((item) => item.id));
  if (questions.length !== 12 || uniqueIds.size !== questions.length) {
    throw new Error(`Expected 12 unique history questions, found ${questions.length}`);
  }

  return questions;
}

export function selectRemainingQuestions(
  questionBank: QuestionBankItem[],
  coveredQuestionIds: Iterable<string>,
  limit = 5
): QuestionBankItem[] {
  const covered = new Set(coveredQuestionIds);
  const selected: QuestionBankItem[] = [];

  for (const priority of ['P1', 'P2', 'P3'] as const) {
    const presentIllness = questionBank.filter((item) => item.priority === priority && item.category === 'present_illness' && !covered.has(item.id));
    const pastHistory = questionBank.filter((item) => item.priority === priority && item.category === 'past_history' && !covered.has(item.id));
    const maxLength = Math.max(presentIllness.length, pastHistory.length);

    for (let index = 0; index < maxLength && selected.length < limit; index += 1) {
      if (presentIllness[index]) selected.push(presentIllness[index]);
      if (pastHistory[index] && selected.length < limit) selected.push(pastHistory[index]);
    }
    if (selected.length >= limit) break;
  }

  return selected;
}

@Injectable()
export class PromptService {
  loadContext(): PromptContext {
    const promptFile = this.resolveProjectPath(process.env.PROMPT_FILE ?? defaultPromptFile);
    const knowledgeDir = this.resolveProjectPath(process.env.KNOWLEDGE_DIR ?? defaultKnowledgeDir);

    if (!existsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }
    if (!existsSync(knowledgeDir)) {
      throw new Error(`Knowledge directory not found: ${knowledgeDir}`);
    }

    const availableFiles = new Set(readdirSync(knowledgeDir));
    const knowledgeFiles = knowledgeFileNames
      .filter((fileName) => availableFiles.has(fileName))
      .map((fileName) => {
        const fullPath = resolve(knowledgeDir, fileName);
        return {
          fileName,
          content: readFileSync(fullPath, 'utf8'),
          updatedAt: statSync(fullPath).mtime.toISOString()
        };
      });

    const basicQuestionBank = knowledgeFiles.find((file) => file.fileName === 'basic_question_bank.md');
    if (!basicQuestionBank) {
      throw new Error('basic_question_bank.md not found');
    }

    if (knowledgeFiles.length === 0) {
      throw new Error('No knowledge files loaded');
    }

    return {
      systemPrompt: readFileSync(promptFile, 'utf8'),
      questionBank: parseQuestionBank(basicQuestionBank.content),
      knowledgeFiles
    };
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
}
