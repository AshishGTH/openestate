import type { Response } from 'express';

function escapeCsvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Streams CSV rows to the response as they're produced, never buffering the
 * whole body in memory. Because Content-Length is never set and the
 * response is written across multiple `res.write()` calls, Node emits
 * `Transfer-Encoding: chunked` automatically (HTTP/1.1) — the property the
 * CSV-streaming test asserts on.
 */
export async function streamCsv(
  res: Response,
  filename: string,
  headers: string[],
  rows: AsyncIterable<unknown[]> | Iterable<unknown[]>,
): Promise<void> {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.write(headers.map(escapeCsvCell).join(',') + '\n');
  for await (const row of rows) {
    res.write(row.map(escapeCsvCell).join(',') + '\n');
  }
  res.end();
}
