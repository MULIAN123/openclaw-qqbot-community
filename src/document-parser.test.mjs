import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDocumentContext, DocumentParserError } from "./document-parser.ts";

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-document-parser-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(name, content) {
      const filePath = path.join(root, name);
      fs.writeFileSync(filePath, content);
      return filePath;
    },
  };
}

function logCapture() {
  const entries = [];
  return { entries, logger: { info: (message) => entries.push(message), error: (message) => entries.push(message) } };
}

test("plain text formats are read locally from the trusted root", (t) => {
  const fixture = makeFixture(t);
  for (const extension of [".txt", ".md", ".py"]) {
    const filePath = fixture.write(`fixture${extension}`, Buffer.from(`text-${extension}`, "utf8"));
    const context = buildDocumentContext([filePath], undefined, { trustedRoot: fixture.root });
    assert.match(context, new RegExp(`text-${extension.replace(".", "\\.")}`));
    assert.match(context, new RegExp(`文件类型：\\${extension}`));
  }
});

test("PDF, DOCX, and XLSX use the injected parser with bounded file bytes", (t) => {
  const fixture = makeFixture(t);
  const seen = [];
  const parser = { parse: ({ extension, filename, content }) => { seen.push({ extension, filename, content: content.toString("utf8") }); return `mock-${extension}`; } };
  for (const extension of [".pdf", ".docx", ".xlsx"]) {
    const filePath = fixture.write(`fixture${extension}`, Buffer.from(`input-${extension}`, "utf8"));
    const context = buildDocumentContext([filePath], undefined, { trustedRoot: fixture.root, parser });
    assert.match(context, new RegExp(`mock-${extension.replace(".", "\\.")}`));
  }
  assert.deepEqual(seen.map((item) => item.extension), [".pdf", ".docx", ".xlsx"]);
  assert.ok(seen.every((item) => item.filename.startsWith("fixture.")));
});

test("missing optional parser reports unavailable and never claims extracted text", (t) => {
  const fixture = makeFixture(t);
  const filePath = fixture.write("fixture.pdf", Buffer.from("synthetic-pdf"));
  const context = buildDocumentContext([filePath], undefined, { trustedRoot: fixture.root });
  assert.match(context, /parser_not_configured/);
  assert.doesNotMatch(context, /synthetic-pdf|已提取文本如下/);
});

test("parser failure is non-throwing and exposes only a stable error code", (t) => {
  const fixture = makeFixture(t);
  const filePath = fixture.write("fixture.docx", Buffer.from("synthetic-doc"));
  const capture = logCapture();
  const parser = { parse: () => { throw new Error("synthetic-doc secret-body /synthetic-private/document.docx"); } };
  const context = buildDocumentContext([filePath], capture.logger, { trustedRoot: fixture.root, parser });
  assert.match(context, /parse_failed/);
  assert.doesNotMatch(context, /synthetic-doc|secret-body|private/);
  assert.doesNotMatch(capture.entries.join("\n"), /synthetic-doc|secret-body|private/);
});

test("adapter-reported timeout is surfaced as failure without claiming success", (t) => {
  const fixture = makeFixture(t);
  const filePath = fixture.write("fixture.xlsx", Buffer.from("synthetic-sheet"));
  const parser = { parse: () => { throw new DocumentParserError("parser_timeout"); } };
  const context = buildDocumentContext([filePath], undefined, { trustedRoot: fixture.root, parser });
  assert.match(context, /parser_timeout/);
  assert.doesNotMatch(context, /已提取文本如下|synthetic-sheet/);
});

test("abnormal parser output is rejected", (t) => {
  const fixture = makeFixture(t);
  const filePath = fixture.write("fixture.pdf", Buffer.from("synthetic-pdf"));
  const parser = { parse: () => ({ text: "fake success" }) };
  const context = buildDocumentContext([filePath], undefined, { trustedRoot: fixture.root, parser });
  assert.match(context, /invalid_parser_output/);
  assert.doesNotMatch(context, /fake success|已提取文本如下/);
});

test("missing files and paths outside the trusted root fail closed", (t) => {
  const fixture = makeFixture(t);
  const missing = path.join(fixture.root, "missing.txt");
  const outside = path.join(path.dirname(fixture.root), `${path.basename(fixture.root)}-outside.txt`);
  fs.writeFileSync(outside, "outside-fixture");
  t.after(() => fs.rmSync(outside, { force: true }));
  assert.match(buildDocumentContext([missing], undefined, { trustedRoot: fixture.root }), /file_not_found/);
  const outsideContext = buildDocumentContext([outside], undefined, { trustedRoot: fixture.root });
  assert.match(outsideContext, /untrusted_source/);
  assert.doesNotMatch(outsideContext, /outside-fixture/);
});

test("directories and junctions resolving outside the trusted root are rejected", (t) => {
  const fixture = makeFixture(t);
  const directoryPath = path.join(fixture.root, "directory.txt");
  fs.mkdirSync(directoryPath);
  assert.match(buildDocumentContext([directoryPath], undefined, { trustedRoot: fixture.root }), /file_unavailable/);

  const outside = path.join(path.dirname(fixture.root), `${path.basename(fixture.root)}-junction-target`);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "escaped.txt"), "junction-target-fixture");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const junction = path.join(fixture.root, "redirect");
  fs.symlinkSync(outside, junction, "junction");
  const escapedPath = path.join(junction, "escaped.txt");
  const context = buildDocumentContext([escapedPath], undefined, { trustedRoot: fixture.root });
  assert.match(context, /untrusted_source/);
  assert.doesNotMatch(context, /junction-target-fixture/);
});

test("oversized inputs are rejected before parser invocation", (t) => {
  const fixture = makeFixture(t);
  const filePath = fixture.write("fixture.pdf", Buffer.from("0123456789"));
  let called = false;
  const parser = { parse: () => { called = true; return "unexpected"; } };
  const context = buildDocumentContext([filePath], undefined, { trustedRoot: fixture.root, maxInputBytes: 4, parser });
  assert.match(context, /file_too_large/);
  assert.equal(called, false);
});

test("formatted extracted text is capped at 8,000 characters", (t) => {
  const fixture = makeFixture(t);
  const filePath = fixture.write("fixture.pdf", Buffer.from("synthetic-pdf"));
  const parser = { parse: () => "x".repeat(9_000) };
  const context = buildDocumentContext([filePath], undefined, { trustedRoot: fixture.root, parser });
  const extracted = context.split("提取内容：\n---\n")[1]?.split("\n\n=== 文档内容较长")[0] ?? "";
  assert.equal(extracted.length, 8_000);
  assert.match(context, /前 8000 字符截断结果/);
});

test("unsupported extensions are ignored without invoking a parser", (t) => {
  const fixture = makeFixture(t);
  const filePath = fixture.write("fixture.png", Buffer.from("not-a-document"));
  let called = false;
  const context = buildDocumentContext([filePath], undefined, { trustedRoot: fixture.root, parser: { parse: () => { called = true; return "unexpected"; } } });
  assert.equal(context, "");
  assert.equal(called, false);
});
