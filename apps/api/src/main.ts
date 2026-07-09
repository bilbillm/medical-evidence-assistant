import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './modules/app.module.js';

const port = Number(process.env.API_PORT ?? 3001);

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix('api');
  await app.listen(port);
}

bootstrap();
