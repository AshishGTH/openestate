import 'reflect-metadata';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { AppModule } from './app.module';

// Money is stored as BigInt paise everywhere per CLAUDE.md, but native
// BigInt has no JSON representation — Express's res.json() (JSON.stringify)
// throws "Do not know how to serialize a BigInt" on any controller response
// containing a raw Prisma money field. This is the standard global fix:
// every *Paise field crosses the wire as a decimal string, which the
// frontend re-parses with BigInt(...) before formatting. Applies uniformly
// to every response — no controller/service has to remember to .toString()
// its own money fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ZodValidationPipe());

  // Trust exactly one hop (nginx — see deploy/native/*, the only reverse
  // proxy in front of this process) so req.secure reflects the CLIENT's
  // actual scheme via X-Forwarded-Proto, not the always-plain-http
  // nginx-to-node connection. Cookie Secure flags key off req.secure, not
  // NODE_ENV — see auth.controller.ts/portal-auth.controller.ts's doc
  // comment for the bug this fixes: NODE_ENV==='production' is true on
  // every real native install regardless of whether TLS is actually
  // configured (it deliberately isn't, out of the box — see the nginx
  // config's own comment), so Secure cookies were being set on a plain
  // HTTP connection. Browsers silently refuse to store a Secure cookie
  // over non-HTTPS — no CSRF cookie, no refresh cookie, ever, in any real
  // browser hitting a fresh install. Only caught because this session's
  // VM walkthrough was the first time a real browser (not curl) drove a
  // mutation against the actual deployed VM.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const corsAllowlist = (process.env.CORS_ALLOWLIST ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsAllowlist.length > 0 ? corsAllowlist : false,
    credentials: true,
  });

  const swaggerEnabled = process.env.SWAGGER_ENABLED
    ? process.env.SWAGGER_ENABLED === 'true'
    : process.env.NODE_ENV !== 'production';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('OpenEstate API')
      .setDescription('OpenEstate CRM REST API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/v1/docs', app, document);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
