import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // rawBody: webhook signatures are computed over the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // The admin page (web, :3200) calls the API from the browser.
  app.enableCors({
    origin: ['http://localhost:3200', 'http://127.0.0.1:3200'],
  });
  const docs = new DocumentBuilder()
    .setTitle('Mithal Store orders and payments')
    .setVersion('1')
    .build();
  SwaggerModule.setup('docs', app, () =>
    SwaggerModule.createDocument(app, docs),
  );
  await app.listen(process.env.PORT ?? 8100, '0.0.0.0');
}
await bootstrap();
