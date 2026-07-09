import { Controller, Get } from '@nestjs/common';

@Controller()
export class ServeStaticController {
  @Get('health')
  health() {
    return {
      status: 'ok',
      database: process.env.DATABASE_URL ? 'configured' : 'not_configured',
      uploads: process.env.UPLOAD_DIR ?? 'data/uploads'
    };
  }
}
