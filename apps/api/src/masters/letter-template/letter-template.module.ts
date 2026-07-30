import { Module } from '@nestjs/common';
import { LetterTemplateController } from './letter-template.controller';
import { LetterTemplateService } from './letter-template.service';

@Module({
  controllers: [LetterTemplateController],
  providers: [LetterTemplateService],
  exports: [LetterTemplateService],
})
export class LetterTemplateModule {}
