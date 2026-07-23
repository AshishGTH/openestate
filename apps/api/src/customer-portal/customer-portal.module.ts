import { Module } from '@nestjs/common';
import { PdfModule } from '../pdf/pdf.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PostsalesModule } from '../postsales/postsales.module';
import { ApplicantChangeRequestService } from './applicant-change-request.service';
import { PortalProfileService } from './portal-profile.service';
import { PortalProfileController } from './portal-profile.controller';
import { AdminChangeRequestController } from './admin-change-request.controller';
import { PortalPropertyService } from './portal-property.service';
import { PortalPropertyController } from './portal-property.controller';
import { PortalAccountService } from './portal-account.service';
import { PortalAccountController } from './portal-account.controller';
import { TicketService } from './ticket.service';
import { PortalTicketController } from './portal-ticket.controller';
import { AdminTicketController } from './admin-ticket.controller';
import { ConstructionUpdateService } from './construction-update.service';
import { ConstructionUpdateAdminController } from './construction-update-admin.controller';

@Module({
  imports: [PdfModule, InventoryModule, PostsalesModule],
  controllers: [
    PortalProfileController,
    AdminChangeRequestController,
    PortalPropertyController,
    PortalAccountController,
    PortalTicketController,
    AdminTicketController,
    ConstructionUpdateAdminController,
  ],
  providers: [
    ApplicantChangeRequestService,
    PortalProfileService,
    PortalPropertyService,
    PortalAccountService,
    TicketService,
    ConstructionUpdateService,
  ],
})
export class CustomerPortalModule {}
