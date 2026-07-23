import { Module } from '@nestjs/common';
import { BrokersModule } from '../brokers/brokers.module';
import { PdfModule } from '../pdf/pdf.module';
import { PortalAuthModule } from '../portal-auth/portal-auth.module';
import { PortalBrokerDashboardService } from './portal-broker-dashboard.service';
import { PortalBrokerDashboardController } from './portal-broker-dashboard.controller';
import { PortalBrokerNocController } from './portal-broker-noc.controller';
import { PortalBrokerDocumentsController } from './portal-broker-documents.controller';

/**
 * Separate from CustomerPortalModule (Phase 6 commit 2) despite both being
 * "portal" modules — keeps that module's name accurate, and this one's
 * controllers depend on BrokersModule's NocService (broker NOC actions)
 * and PdfModule's DocumentService (statement download), neither of which
 * CustomerPortalModule imports.
 */
@Module({
  imports: [BrokersModule, PdfModule, PortalAuthModule],
  controllers: [PortalBrokerDashboardController, PortalBrokerNocController, PortalBrokerDocumentsController],
  providers: [PortalBrokerDashboardService],
})
export class BrokersPortalModule {}
