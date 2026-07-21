/**
 * @types/pdfmake only types the browser bundle (`pdfmake/build/pdfmake`,
 * `pdfmake.createPdf(...)`). The Node-side `PdfPrinter` class and its two
 * URL-resolution collaborators live at deep import paths with no published
 * types, so they get minimal ambient declarations here — just enough
 * surface for PdfService. Verified against
 * pdfmake@0.3.11/js/{Printer,URLResolver,virtual-fs}.js:
 * `createPdfKitDocument` is `async` (it awaits `resolveUrls()` first, which
 * itself awaits `urlResolver.resolved()`), and the constructor takes all
 * four params — passing only `fonts` leaves `urlResolver` undefined, which
 * `resolveUrls()` then crashes dereferencing.
 */
declare module 'pdfmake/js/Printer' {
  import type { Readable } from 'node:stream';
  import type { TDocumentDefinitions } from 'pdfmake/interfaces';

  export interface PdfFontDescriptor {
    normal: string;
    bold?: string;
    italics?: string;
    bolditalics?: string;
  }

  export interface PdfUrlResolver {
    resolve(url: string, headers?: Record<string, string>): Promise<void>;
    resolved(): Promise<unknown>;
  }

  export default class PdfPrinter {
    constructor(
      fonts: Record<string, PdfFontDescriptor>,
      virtualFs?: unknown,
      urlResolver?: PdfUrlResolver,
      localAccessPolicy?: (path: string) => boolean,
    );
    createPdfKitDocument(
      docDefinition: TDocumentDefinitions,
      options?: Record<string, unknown>,
    ): Promise<Readable & { end(): void }>;
  }
}

declare module 'pdfmake/js/URLResolver' {
  import type { PdfUrlResolver } from 'pdfmake/js/Printer';

  export default class URLResolver implements PdfUrlResolver {
    constructor(fs: unknown);
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    resolve(url: string, headers?: Record<string, string>): Promise<void>;
    resolved(): Promise<unknown>;
  }
}

declare module 'pdfmake/js/virtual-fs' {
  const virtualFs: unknown;
  export default virtualFs;
}
