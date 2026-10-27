// Log-safety scanner: finds log/audit calls and flags interpolations that may carry
// message text, raw user/group IDs, URLs, raw errors, or whole-object JSON.
// A call can be exempted with a trailing `// log-safe: <reason>` comment after review.
// Usage: node scripts/log-safety-scan.mjs <srcDir> [--json]
import fs from "node:fs";
import path from "node:path";

export const CALL_RE = /(?<![\w$])(?:console\.(?:log|info|warn|error|debug)|(?:[A-Za-z_$][\w$]*\??\.)*[A-Za-z_$]*(?:[lL]og|[lL]ogger)\??\.(?:info|warn|error|debug)(?:\?\.)?|append\w*Audit\w*|appendFileSync)\s*\(/g;

/** Return the index just past the matching ')' for a call whose '(' is at openIdx. */
export function findCallEnd(src, openIdx) {
  let i = openIdx + 1, depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const q = ch; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++; continue;
    }
    if (ch === "`") { i = skipTemplate(src, i); continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    i++;
  }
  return i;
}

/** i points at opening backtick; returns index after closing backtick. */
export function skipTemplate(src, i) {
  i++;
  while (i < src.length && src[i] !== "`") {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "$" && src[i + 1] === "{") { i = skipBraces(src, i + 1); continue; }
    i++;
  }
  return i + 1;
}

export function skipBraces(src, i) { // i at '{'
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") { const q = ch; i++; while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; } i++; continue; }
    if (ch === "`") { i = skipTemplate(src, i); continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

/** Extract ${...} expressions from every template literal in text, plus top-level args after the first. */
function extractExprs(callText) {
  const exprs = [];
  const collect = (s) => {
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "`") {
        let j = i + 1;
        while (j < s.length && s[j] !== "`") {
          if (s[j] === "\\") { j += 2; continue; }
          if (s[j] === "$" && s[j + 1] === "{") {
            const end = skipBraces(s, j + 1);
            const inner = s.slice(j + 2, end - 1);
            exprs.push(inner.trim());
            collect(inner);
            j = end; continue;
          }
          j++;
        }
        i = j;
      }
    }
  };
  collect(callText);
  // top-level args
  const inner = callText.slice(callText.indexOf("(") + 1, -1);
  const args = []; let depth = 0, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' || ch === "'") { const q = ch; i++; while (i < inner.length && inner[i] !== q) { if (inner[i] === "\\") i++; i++; } continue; }
    if (ch === "`") { i = skipTemplate(inner, i) - 1; continue; }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) { args.push(inner.slice(start, i)); start = i + 1; }
  }
  args.push(inner.slice(start));
  for (const a of args.slice(1)) { const t = a.trim(); if (t) exprs.push(t); }
  if (args[0] && !/^\s*[`'"]/.test(args[0])) exprs.push(args[0].trim()); // non-literal first arg
  return exprs;
}

const SAFE_WRAP = /^(redactId|redactUrl|safeError|hashText|hashAuditText|maskAuditId|maskSensitiveId|Buffer\.byteLength|Object\.keys)\(/;
const LENGTHISH = /(\??\.length|\.size|\.count)(\s*\?\?\s*\d+)?$/;
// Properties that only carry a type/kind/status, never user data.
const SAFE_PROP = /\??\.(type|t|op|kind|mediaType|targetType|status|statusText|code|name|id\b(?=\s*$)(?<=msg\.id|message\.id))$/;
const RULES = [
  ["json", /JSON\.stringify\s*\(/],
  ["error", /^(String\()?(err|e|error|ex|errMsg|errorMessage|errMessage|reason|lastErr|lastError|imgErr|parseErr|innerErr|fetchErr|uploadErr|sendErr|ttsErr|sttErr|dlErr|retryErr|psErr|shErr)\b(\.message|\.stack|\.toString\(\))?/],
  ["error", /\.(message|stack)\b/],
  ["id", /(^|[^\w$.])(\w*[oO]pen_?[iI]d\w*|senderId|peerId|userId|groupId|guildId|chatId|memberId|targetId|targetAddress|target|to|replyToSender|senderName|username|nickname|author)\b|\.(\w*[oO]pen_?[iI]d\w*|senderId|peerId|userId|groupId|targetAddress)\b|\btarget\??\.id\b/],
  // leaf fields that hold message text
  ["content", /(^|[^\w$])(content|text|transcript|prompt|replyText|replyToBody|caption|question|userText|delegatePrompt|contentForCommand|preview|ttsText|asrReferText|chunk|textContent|cleanText|finalText|inputText)\b/],
  // containers: only when logged whole (not when a sub-field is read)
  ["content", /(^|[^\w$.])(body|rawBody|payload|data|event|d)\b(?!\s*\??\.)/],
  ["url", /(^|[^\w$])(\w*[uU]rl\w*|\w*URL\w*|href)\b/],
];

/** Strip string literals and boolean flag identifiers so they don't trigger rules. */
function normalize(expr) {
  return expr
    .replace(/\s+/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/\b(?:is|has|should|can)[A-Z]\w*\b/g, "flag");
}

export function classify(expr) {
  const e = normalize(expr);
  if (SAFE_WRAP.test(e) || LENGTHISH.test(e) || /^Boolean\(/.test(e) || /^typeof /.test(e)) return null;
  if (SAFE_PROP.test(e) && !/[?:]/.test(e.replace(/\?\./g, ""))) return null;
  for (const [kind, re] of RULES) if (re.test(e)) return kind;
  return null;
}

export function scanSource(src) {
  const findings = [];
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src))) {
    const open = m.index + m[0].length - 1;
    const end = findCallEnd(src, open);
    const call = src.slice(m.index, end);
    const line = src.slice(0, m.index).split("\n").length;
    const lineEnd = src.indexOf("\n", end);
    const tail = src.slice(end, lineEnd === -1 ? undefined : lineEnd);
    if (/\/\/\s*log-safe:/.test(tail)) continue;
    for (const expr of extractExprs(call)) {
      const kind = classify(expr);
      if (kind) findings.push({ line, kind, expr: expr.length > 90 ? expr.slice(0, 90) + "…" : expr });
    }
  }
  return findings;
}

export function scanDir(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { if (!["node_modules", "dist", ".verify-dist"].includes(ent.name)) walk(p); continue; }
      if (!/\.(ts|mjs|js|cjs)$/.test(ent.name) || /\.test\./.test(ent.name) || /\.d\.ts$/.test(ent.name)) continue;
      for (const f of scanSource(fs.readFileSync(p, "utf8"))) out.push({ file: path.relative(dir, p).replace(/\\/g, "/"), ...f });
    }
  };
  walk(dir);
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const dir = process.argv[2];
  const res = scanDir(dir);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(res, null, 1)); } // log-safe: scanner CLI report of source locations, no runtime data
  else {
    const byKind = {}; for (const r of res) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    console.log("total", res.length, JSON.stringify(byKind)); // log-safe: scanner CLI summary counts only
    for (const r of res) console.log(`${r.file}:${r.line} [${r.kind}] ${r.expr}`);
  }
}
