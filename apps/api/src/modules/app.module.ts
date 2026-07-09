import { Module } from '@nestjs/common';
import { ServeStaticController } from './serve-static.controller.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { PromptService } from './prompt.service.js';
import { MockAiGateway } from './mock-ai.gateway.js';
import { PackageService } from './package.service.js';

@Module({
  controllers: [SessionsController, ServeStaticController],
  providers: [SessionsService, PromptService, MockAiGateway, PackageService]
})
export class AppModule {}
