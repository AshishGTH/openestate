import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import PdfPrinter from 'pdfmake/js/Printer';
import URLResolver from 'pdfmake/js/URLResolver';
import virtualFs from 'pdfmake/js/virtual-fs';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

// Resolve pdfmake's own bundled Roboto TTFs relative to its installed
// package.json, so this works regardless of pnpm's symlink layout or the
// process's working directory (dev, test, or the Docker runtime image).
const pdfmakePkgPath = require.resolve('pdfmake/package.json');
const robotoDir = path.join(path.dirname(pdfmakePkgPath), 'fonts', 'Roboto');

const FONTS = {
  Roboto: {
    normal: path.join(robotoDir, 'Roboto-Regular.ttf'),
    bold: path.join(robotoDir, 'Roboto-Medium.ttf'),
    italics: path.join(robotoDir, 'Roboto-Italic.ttf'),
    bolditalics: path.join(robotoDir, 'Roboto-MediumItalic.ttf'),
  },
};

/**
 * Thin wrapper around pdfmake's Node `PdfPrinter`. Pure function of a
 * docDefinition → Buffer; no persistence, no DB access — that's
 * DocumentService's job.
 */
@Injectable()
export class PdfService {
  // pdfmake's Node PdfPrinter.createPdfKitDocument unconditionally calls
  // resolveUrls() first, which needs a real urlResolver (with .resolve()/
  // .resolved()) even though our font paths and template content are all
  // local — it only does actual network I/O for http(s):// URLs, so this
  // resolves as a no-op for every doc we generate. Using pdfmake's own
  // shipped URLResolver/virtual-fs rather than a hand-rolled stub.
  private readonly printer = new PdfPrinter(FONTS, virtualFs, new URLResolver(virtualFs), undefined);

  async render(docDefinition: TDocumentDefinitions): Promise<Buffer> {
    const doc = await this.printer.createPdfKitDocument(docDefinition);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });
  }
}
