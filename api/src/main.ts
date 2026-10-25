import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // rawBody: webhook signatures are computed over the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
