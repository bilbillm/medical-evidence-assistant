import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { existsSync } from 'node:fs';
import type { Response } from 'express';
import { SubmitMessageRequest } from '@medical-evidence/shared';
import { PackageService } from './package.service.js';
import { SessionsService } from './sessions.service.js';

let sessionsServiceRef: SessionsService;
let packageServiceRef: PackageService;

@Controller('sessions')
export class SessionsController {
  constructor(
    @Inject(SessionsService)
    sessionsService: SessionsService,
    @Inject(PackageService)
    packageService: PackageService
  ) {
    sessionsServiceRef = sessionsService;
    packageServiceRef = packageService;
  }

  @Post()
  createSession() {
    return { session: sessionsServiceRef.createSession() };
  }

  @Get(':sessionId')
  getSession(@Param('sessionId') sessionId: string) {
    return { session: sessionsServiceRef.getSession(sessionId) };
  }

  @Post(':sessionId/messages')
  async submitMessage(@Param('sessionId') sessionId: string, @Body() body: SubmitMessageRequest) {
    return sessionsServiceRef.submitText(sessionId, body.content ?? '', body.attachmentDocumentIds ?? []);
  }

  @Post(':sessionId/messages/stream')
  async submitMessageStream(
    @Param('sessionId') sessionId: string,
    @Body() body: SubmitMessageRequest,
    @Res() response: Response
  ) {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    try {
      for await (const chunk of sessionsServiceRef.streamSubmitText(sessionId, body.content ?? '', body.attachmentDocumentIds ?? [])) {
        response.write(chunk);
        (response as Response & { flush?: () => void }).flush?.();
      }
      response.end();
    } catch (error) {
      response.write(`\n\n[生成失败] ${error instanceof Error ? error.message : '未知错误'}`);
      (response as Response & { flush?: () => void }).flush?.();
      response.end();
    }
  }

  @Post(':sessionId/text-document')
  async submitTextDocument(@Param('sessionId') sessionId: string, @Body() body: SubmitMessageRequest) {
    return sessionsServiceRef.addTextDocument(sessionId, body.content ?? '');
  }

  @Post(':sessionId/files')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadFile(@Param('sessionId') sessionId: string, @UploadedFile() file?: Express.Multer.File) {
    return sessionsServiceRef.addUploadedFile(sessionId, file);
  }

  @Post(':sessionId/files/batch')
  @UseInterceptors(FilesInterceptor('files', 8, { storage: memoryStorage() }))
  async uploadFiles(@Param('sessionId') sessionId: string, @UploadedFiles() files: Express.Multer.File[] | undefined, @Body() body: { askNext?: string }) {
    return sessionsServiceRef.addUploadedFiles(sessionId, files ?? [], body.askNext !== 'false');
  }

  @Get(':sessionId/files/:fileName')
  async getUploadedFile(
    @Param('sessionId') sessionId: string,
    @Param('fileName') fileName: string,
    @Res() response: Response
  ) {
    const filePath = sessionsServiceRef.uploadedFilePath(sessionId, fileName);
    if (!existsSync(filePath)) {
      throw new NotFoundException('File not found');
    }
    response.sendFile(filePath);
  }

  @Post(':sessionId/audio')
  @UseInterceptors(FileInterceptor('audio', { storage: memoryStorage() }))
  async transcribeAudio(@UploadedFile() audio?: Express.Multer.File) {
    return { transcript: await sessionsServiceRef.transcribeAudio(audio) };
  }

  @Post(':sessionId/generate-patient-view')
  async generatePatientView(@Param('sessionId') sessionId: string) {
    const patientView = await sessionsServiceRef.generatePatientView(sessionId);
    return { session: sessionsServiceRef.getSession(sessionId), patientView };
  }

  @Post(':sessionId/generate-doctor-package')
  async generateDoctorPackage(@Param('sessionId') sessionId: string) {
    const doctorPackage = await sessionsServiceRef.generateDoctorPackage(sessionId);
    return { session: sessionsServiceRef.getSession(sessionId), doctorPackage };
  }

  @Post(':sessionId/generate-doctor-package/stream')
  async generateDoctorPackageStream(
    @Param('sessionId') sessionId: string,
    @Res() response: Response
  ) {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    try {
      for await (const chunk of sessionsServiceRef.streamDoctorPackage(sessionId)) {
        response.write(chunk);
        (response as Response & { flush?: () => void }).flush?.();
      }
      response.end();
    } catch (error) {
      response.write(`\n\n[生成失败] ${error instanceof Error ? error.message : '未知错误'}`);
      (response as Response & { flush?: () => void }).flush?.();
      response.end();
    }
  }

  @Post(':sessionId/packages/patient')
  async createPatientPackage(@Param('sessionId') sessionId: string) {
    return packageServiceRef.createPackage(sessionId, 'patient');
  }

  @Post(':sessionId/packages/doctor')
  async createDoctorPackage(@Param('sessionId') sessionId: string) {
    return packageServiceRef.createPackage(sessionId, 'doctor');
  }

  @Get(':sessionId/packages/:packageType/download')
  async downloadPackage(
    @Param('sessionId') sessionId: string,
    @Param('packageType') packageType: 'patient' | 'doctor',
    @Res() response: Response
  ) {
    const session = sessionsServiceRef.getSession(sessionId);
    const item = session.packages.find((pkg) => pkg.packageType === packageType) ?? await packageServiceRef.createPackage(sessionId, packageType);
    response.download(packageServiceRef.packagePath(item.fileName), item.fileName);
  }
}
