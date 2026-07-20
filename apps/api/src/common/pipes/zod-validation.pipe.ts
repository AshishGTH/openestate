// Re-exported so app-specific DTOs (`createZodDto`) and the global pipe
// registration in main.ts share one import path.
export { ZodValidationPipe, createZodDto } from 'nestjs-zod';
