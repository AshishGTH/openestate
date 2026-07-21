import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UploadCategory } from '@openestate/shared';
import { UPLOAD_CATEGORIES } from '@openestate/shared';

const MAGIC_BYTES: Record<string, { offset: number; bytes: number[] }> = {
  '.jpg': { offset: 0, bytes: [0xff, 0xd8, 0xff] },
  '.jpeg': { offset: 0, bytes: [0xff, 0xd8, 0xff] },
  '.png': { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] },
  '.pdf': { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  '.xlsx': { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
};

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.pdf', '.xlsx']);

const SIZE_LIMITS: Record<UploadCategory, number> = {
  layout_plan: 10 * 1024 * 1024,
  brochure: 10 * 1024 * 1024,
  photo: 5 * 1024 * 1024,
  document: 10 * 1024 * 1024,
};

export interface UploadResult {
  storageName: string;
  originalName: string;
  mimeType: string;
  size: number;
  category: UploadCategory;
  path: string;
}

@Injectable()
export class UploadService {
  private readonly uploadsRoot: string;

  constructor() {
    this.uploadsRoot = process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads');
  }

  /** Filesystem path for a previously-stored file (never used to derive a path from user input). */
  pathFor(category: UploadCategory, storageName: string): string {
    return path.join(this.uploadsRoot, category, storageName);
  }

  async validateAndStore(
    file: { buffer: Buffer; originalname: string; size: number },
    category: string,
  ): Promise<UploadResult> {
    if (!UPLOAD_CATEGORIES.includes(category as UploadCategory)) {
      throw new BadRequestException(`Invalid upload category: ${category}. Allowed: ${UPLOAD_CATEGORIES.join(', ')}`);
    }

    const cat = category as UploadCategory;
    const ext = path.extname(file.originalname).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`File extension ${ext} is not allowed`);
    }

    if (file.size > SIZE_LIMITS[cat]) {
      throw new BadRequestException(
        `File exceeds size limit of ${SIZE_LIMITS[cat] / (1024 * 1024)}MB for category ${cat}`,
      );
    }

    const magic = MAGIC_BYTES[ext];
    if (magic) {
      const headerSlice = file.buffer.subarray(magic.offset, magic.offset + magic.bytes.length);
      const matches = magic.bytes.every((b, i) => headerSlice[i] === b);
      if (!matches) {
        throw new BadRequestException('File content does not match its extension (magic byte check failed)');
      }
    }

    const mimeType = this.getMimeType(ext);
    const storageName = `${randomUUID()}${ext}`;
    const categoryDir = path.join(this.uploadsRoot, cat);
    const filePath = path.join(categoryDir, storageName);

    await fs.promises.mkdir(categoryDir, { recursive: true });

    if (['.jpg', '.jpeg', '.png'].includes(ext)) {
      const processedBuffer = await this.processImage(file.buffer, ext);
      await fs.promises.writeFile(filePath, processedBuffer);
    } else {
      await fs.promises.writeFile(filePath, file.buffer);
    }

    return {
      storageName,
      originalName: file.originalname,
      mimeType,
      size: file.size,
      category: cat,
      path: filePath,
    };
  }

  private async processImage(buffer: Buffer, ext: string): Promise<Buffer> {
    try {
      const sharp = (await import('sharp')).default;
      const format = ext === '.png' ? 'png' : 'jpeg';
      return await sharp(buffer)
        .rotate()
        .toFormat(format, { quality: 85 })
        .toBuffer();
    } catch {
      return buffer;
    }
  }

  private getMimeType(ext: string): string {
    const map: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.pdf': 'application/pdf',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    return map[ext] ?? 'application/octet-stream';
  }
}
