import { Injectable } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PackageDownloadDto, ResultCardDto } from '@medical-evidence/shared';
import { SessionsService } from './sessions.service.js';

function timestamp() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

@Injectable()
export class PackageService {
  constructor(private readonly sessionsService: SessionsService) {}

  async createPackage(sessionId: string, packageType: 'patient' | 'doctor'): Promise<PackageDownloadDto> {
    const session = this.sessionsService.requireSession(sessionId);
    const zip = new AdmZip();
    const stamp = timestamp();
    const fileName = packageType === 'patient'
      ? `医检证据助手-患者资料包-${stamp}.zip`
      : `医检证据助手-医生资料包-${stamp}.zip`;

    if (packageType === 'patient') {
      const patientView = session.patientView ?? await this.sessionsService.generatePatientView(sessionId);
      zip.addFile('患者版病程梳理.txt', Buffer.from(this.cardToText(patientView), 'utf8'));
      zip.addFile('资料清单.txt', Buffer.from(session.documents.map((item) => item.displayName).join('\n') || '暂无上传资料', 'utf8'));
      this.addOriginalAttachments(zip, sessionId);
    } else {
      const doctorPackage = session.doctorPackage ?? await this.sessionsService.generateDoctorPackage(sessionId);
      zip.addFile('医生查看版资料包.txt', Buffer.from(this.cardToText(doctorPackage), 'utf8'));
      zip.addFile('资料来源清单.txt', Buffer.from(session.documents.map((item) => `${item.displayName}（${item.sourceType}）`).join('\n') || '暂无上传资料', 'utf8'));
      this.addOriginalAttachments(zip, sessionId);
    }

    const filePath = resolve(this.sessionsService.generatedDir(), fileName);
    zip.writeZip(filePath);

    const download: PackageDownloadDto = {
      packageId: `${packageType}-${stamp}`,
      packageType,
      fileName,
      downloadUrl: `/api/sessions/${sessionId}/packages/${packageType}/download`
    };
    this.sessionsService.registerPackage(sessionId, download);
    return download;
  }

  packagePath(fileName: string) {
    return resolve(this.sessionsService.generatedDir(), fileName);
  }

  private addOriginalAttachments(zip: AdmZip, sessionId: string) {
    const uploadDir = this.sessionsService.uploadDir();
    if (!existsSync(uploadDir)) {
      return;
    }
    for (const fileName of readdirSync(uploadDir).filter((item) => item.startsWith(`${sessionId}-`))) {
      zip.addLocalFile(resolve(uploadDir, fileName), '原始附件');
    }
  }

  private cardToText(card: ResultCardDto) {
    return [card.title, ...card.sections.flatMap((section) => [section.title, ...section.content])].join('\n');
  }
}
