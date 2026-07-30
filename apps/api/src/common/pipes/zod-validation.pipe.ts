import { BadRequestException } from '@nestjs/common';
import { createZodValidationPipe } from 'nestjs-zod';
import type { ZodError } from 'zod';

// nestjs-zod's default ZodValidationException hardcodes `message:
// "Validation failed"` regardless of what actually failed — every 400
// from a zod DTO surfaced that same generic string to the user (found
// during the toast audit; see CLAUDE.md's native-install decisions log).
// Build the message from the real Zod issues instead, so the frontend's
// toast (which just displays `body.message`) shows what's actually wrong.
function formatZodError(error: ZodError): string {
  return error.errors
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

export const ZodValidationPipe = createZodValidationPipe({
  createValidationException: (error) =>
    new BadRequestException({
      statusCode: 400,
      message: formatZodError(error),
      errors: error.errors,
    }),
});

// Re-exported so app-specific DTOs (`createZodDto`) share one import path.
export { createZodDto } from 'nestjs-zod';
