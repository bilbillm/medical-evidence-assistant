import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface PromptContext {
  systemPrompt: string;
  knowledgeFiles: Array<{
    fileName: string;
    content: string;
    updatedAt: string;
  }>;
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

    if (knowledgeFiles.length === 0) {
      throw new Error('No knowledge files loaded');
    }

    return {
      systemPrompt: readFileSync(promptFile, 'utf8'),
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
