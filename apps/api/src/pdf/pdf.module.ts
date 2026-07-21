import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PostsalesModule } from '../postsales/postsales.module';
import { PdfService } from './pdf.service';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';

@Module({
  imports: [InventoryModule, PostsalesModule],
  controllers: [DocumentController],
  providers: [PdfService, DocumentService],
  exports: [PdfService, DocumentService],
})
export class PdfModule {}
