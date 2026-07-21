import { Body, Controller, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { sendCommunicationSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { CommunicationService } from './communication.service';

class SendCommunicationDto extends createZodDto(sendCommunicationSchema) {}

@ApiTags('Communication')
@Controller('applicants/:applicantId/communications')
export class CommunicationController {
  constructor(private readonly communicationService: CommunicationService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.PRESALES_COMMUNICATION_SEND)
  @ApiOperation({ summary: 'Send an email/SMS to an applicant (enqueued via the dev provider)' })
  send(
    @Param('applicantId') applicantId: string,
    @Query('inquiryId') inquiryId: string | undefined,
    @Body() dto: SendCommunicationDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.communicationService.send(
      user.companyId,
      applicantId,
      inquiryId,
      dto,
      user.sub,
    );
  }
}
