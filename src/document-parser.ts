import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DOCUMENT_TEXT_LIMIT = 8_000;
export const DOCUMENT_INPUT_LIMIT_BYTES = 10 * 1024 * 1024;

export const DOCUMENT_EXTENSIONS = [".txt", ".md", ".py", ".pdf", ".docx", ".xlsx"] as const;
export type DocumentExtension = typeof DOCUMENT_EXTENSIONS[number];

export type DocumentParserErrorCode =
  | "parser_not_configured"
  | "parser_timeout"
  | "invalid_parser_output"
  | "parse_failed"
  | "file_not_found"
  | "file_unavailable"
  | "file_too_large"
  | "untrusted_source"
  | "trusted_root_unavailable";

/**
 * A trusted, synchronous adapter for binary formats. It receives only bytes
 * read from the QQBot media directory, never an arbitrary local path. Adapters
 * that invoke another process must enforce their own real process timeout and
 * throw DocumentParserError("parser_timeout") when that timeout expires.
 */
export interface DocumentParser {
  parse(input: {
    filename: string;
    extension: DocumentExtension;
    content: Buffer;
  }): unknown;
}

export interface DocumentParserOptions {
  /** Test/integration seam. Production callers should use the default QQBot media root. */
  trustedRoot?: string;
  /** Optional trusted adapter for PDF, DOCX, and XLSX. */
  parser?: DocumentParser;
  /** Input byte limit. Defaults to 10 MiB. */
  maxInputBytes?: number;
}

export class DocumentParserError extends Error {
  readonly code: DocumentParserErrorCode;

  constructor(code: DocumentParserErrorCode) {
    super(code);
    this.name = "DocumentParserError";
    this.code = code;
  }
}

export interface DocumentParserLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function classifyFailure(error: unknown): DocumentParserErrorCode {
  if (error instanceof DocumentParserError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "file_not_found";
    if (code === "EACCES" || code === "EPERM" || code === "EISDIR") return "file_unavailable";
  }
  return "parse_failed";
}

function defaultTrustedRoot(): string {
  let home: string | undefined;
  try {
    const candidate = os.homedir();
    if (candidate && fs.existsSync(candidate)) home = candidate;
  } catch {
    // Fall back to the standard environment variables below.
  }
  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (!home && envHome && fs.existsSync(envHome)) home = envHome;
  return path.join(home ?? os.tmpdir(), ".openclaw", "media", "qqbot", "downloads");
}

function readBoundedFile(localPath: string, options: DocumentParserOptions): { content: Buffer; filename: string } {
  let trustedRoot: string;
  try {
    trustedRoot = path.resolve(options.trustedRoot ?? defaultTrustedRoot());
  } catch {
    throw new DocumentParserError("trusted_root_unavailable");
  }

  const resolvedPath = path.resolve(localPath);
  if (!isWithin(trustedRoot, resolvedPath) || resolvedPath === trustedRoot) {
    throw new DocumentParserError("untrusted_source");
  }

  let realRoot: string;
  let realPath: string;
  try {
    realRoot = fs.realpathSync(trustedRoot);
    realPath = fs.realpathSync(resolvedPath);
  } catch (error) {
    throw new DocumentParserError(classifyFailure(error));
  }
  if (!isWithin(realRoot, realPath) || realPath === realRoot) {
    throw new DocumentParserError("untrusted_source");
  }

  const maxInputBytes = options.maxInputBytes ?? DOCUMENT_INPUT_LIMIT_BYTES;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) {
    throw new DocumentParserError("file_unavailable");
  }

  let fd: number;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(realPath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new DocumentParserError(classifyFailure(error));
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new DocumentParserError("file_unavailable");
    if (stat.size > maxInputBytes) throw new DocumentParserError("file_too_large");
    const content = fs.readFileSync(fd);
    if (content.length > maxInputBytes) throw new DocumentParserError("file_too_large");
    return { content, filename: path.basename(realPath) };
  } catch (error) {
    throw new DocumentParserError(classifyFailure(error));
  } finally {
    fs.closeSync(fd);
  }
}

function decodeText(content: Buffer): string {
  for (const encoding of ["utf-8", "gbk", "utf-16le"] as const) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(content);
    } catch {
      // Try the next legacy-compatible encoding without exposing file contents.
    }
  }
  throw new DocumentParserError("parse_failed");
}

function parseDocument(
  extension: DocumentExtension,
  file: { content: Buffer; filename: string },
  parser?: DocumentParser,
): unknown {
  if (extension === ".txt" || extension === ".md" || extension === ".py") {
    return decodeText(file.content);
  }
  if (!parser) throw new DocumentParserError("parser_not_configured");
  return parser.parse({ ...file, extension });
}

function formatFailure(code: DocumentParserErrorCode): string {
  return `[文档解析] 附件文本无法提取（${code}）。`;
}

/**
 * Build optional document context from downloaded QQBot attachments.
 * Parsing is synchronous to preserve the existing call contract. Injected
 * adapters must return promptly; this function cannot interrupt a blocked
 * synchronous adapter. No external process is launched by this module.
 */
export function buildDocumentContext(
  localPaths: Array<string | null | undefined> | undefined,
  log?: DocumentParserLogger,
  options: DocumentParserOptions = {},
): string {
  if (!localPaths?.length) return "";

  const supported = new Set<string>(DOCUMENT_EXTENSIONS);
  const seenPaths = new Set<string>();
  const sections: string[] = [];

  for (const localPath of localPaths) {
    if (typeof localPath !== "string" || !localPath || seenPaths.has(localPath)) continue;
    seenPaths.add(localPath);

    const extension = path.extname(localPath).toLowerCase();
    if (!supported.has(extension)) continue;

    try {
      const file = readBoundedFile(localPath, options);
      log?.info(`[qqbot:document-parser] Parsing document: extension=${extension}, bytes=${file.content.length}`);
      const parsed = parseDocument(extension as DocumentExtension, file, options.parser);
      if (typeof parsed !== "string") throw new DocumentParserError("invalid_parser_output");
      const text = parsed.trim();
      if (!text) {
        sections.push(`[文档解析] 用户发送了文件 ${file.filename}，但解析后无文本内容（可能是扫描版 PDF 或纯图片文档）。`);
        continue;
      }

      const limitedText = text.length > DOCUMENT_TEXT_LIMIT
        ? `${text.slice(0, DOCUMENT_TEXT_LIMIT)}\n\n=== 文档内容较长，以上为前 ${DOCUMENT_TEXT_LIMIT} 字符截断结果 ===`
        : text;
      sections.push(
        `[文档解析] 用户发送了一个文件，已提取文本如下：\n文件名：${file.filename}\n文件类型：${extension}\n提取内容：\n---\n${limitedText}\n---\n请基于以上文档内容回答用户问题。`,
      );
      log?.info(`[qqbot:document-parser] Document parsed: extension=${extension}, outputChars=${text.length}`);
    } catch (error) {
      const code = classifyFailure(error);
      log?.error(`[qqbot:document-parser] Document parsing failed: extension=${extension}, code=${code}`);
      sections.push(formatFailure(code));
    }
  }

  return sections.join("\n\n");
}
