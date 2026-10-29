/**
 * Strict YAML 1.2 subset parser: block and flow mappings/sequences, plain,
 * single- and double-quoted scalars, and literal/folded block scalars, with
 * byte-accurate source ranges for every node. This module owns the whole
 * parse; nothing here delegates to an external YAML implementation.
 *
 * Anything outside the declared subset (anchors, aliases, tags, complex
 * keys, tabs used as indentation, flow collections nested more than one
 * level, and any other construct this file does not explicitly recognize)
 * is refused with a `YamlSubsetError` rather than silently misparsed.
 *
 * Every internal parse function returns `{ node, nextPos }`, where `nextPos`
 * is either `null` (end of input) or the offset of the next non-blank,
 * non-comment content character — callers never re-scan for it themselves.
 */

export class YamlSubsetError extends Error {
  constructor(message, code, pos) {
    super(message);
    this.name = "YamlSubsetError";
    this.code = code;
    this.pos = pos;
    this.candidates = [];
  }
}

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/u;
export const INTEGER_PATTERN = /^[+-]?\d+$/u;
export const FLOAT_PATTERN = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/u;

// A plain scalar cannot begin with one of these indicator characters — they
// are reserved for comments, anchors, aliases, tags, quotes, flow
// collections, and other constructs outside the subset.
const PLAIN_START_FORBIDDEN = /^[#&*!|>'"%@`,[\]{}]/u;

function resolvePlainScalar(raw) {
  if (raw === "" || raw === "~" || raw === "null" || raw === "Null" || raw === "NULL") return null;
  if (raw === "true" || raw === "True" || raw === "TRUE") return true;
  if (raw === "false" || raw === "False" || raw === "FALSE") return false;
  if (DATE_PATTERN.test(raw)) return raw;
  if (INTEGER_PATTERN.test(raw)) {
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : raw;
  }
  if (FLOAT_PATTERN.test(raw) && /[.]/u.test(raw)) return Number(raw);
  return raw;
}

// — source lines —

function splitLines(text) {
  const lines = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/gu;
  for (const match of text.matchAll(pattern)) {
    if (match[0] === "") continue;
    const start = match.index;
    const content = match[0].replace(/(?:\r\n|\n|\r)$/u, "");
    lines.push({ start, contentEnd: start + content.length, end: start + match[0].length });
  }
  if (lines.length === 0) lines.push({ start: 0, contentEnd: 0, end: 0 });
  return lines;
}

class Cursor {
  constructor(text) {
    this.text = text;
    this.lines = splitLines(text);
  }
  lineIndexAt(offset) {
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lines[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  lineAt(offset) { return this.lines[this.lineIndexAt(offset)]; }
  col(offset) { return offset - this.lineAt(offset).start; }
}

function fail(message, code, pos) {
  throw new YamlSubsetError(`yaml: invalid document: ${message}`, code, pos);
}

/** Indentation of `line`; throws if a tab appears before the first non-space character. */
function indentEnd(cursor, line) {
  let i = line.start;
  while (i < line.contentEnd && (cursor.text[i] === " " || cursor.text[i] === "\t")) {
    if (cursor.text[i] === "\t") fail("tabs are not allowed in indentation", "TAB_INDENT", i);
    i += 1;
  }
  return i;
}

function isBlankOrComment(cursor, line) {
  const contentStart = indentEnd(cursor, line);
  if (contentStart >= line.contentEnd) return true;
  return cursor.text[contentStart] === "#";
}

/** First content offset at or after `lineIndex`, skipping blank and comment-only lines. Also recognizes and skips a leading `---` / trailing `...` document marker line. Returns `null` at end of input. */
function nextContent(cursor, lineIndex) {
  let index = lineIndex;
  while (index < cursor.lines.length) {
    const line = cursor.lines[index];
    if (isBlankOrComment(cursor, line)) { index += 1; continue; }
    const contentStart = indentEnd(cursor, line);
    const rest = cursor.text.slice(contentStart, line.contentEnd);
    if (rest === "---" || rest === "...") { index += 1; continue; }
    return contentStart;
  }
  return null;
}

function isCommentStart(cursor, pos, lineStart) {
  return cursor.text[pos] === "#" && (pos === lineStart || /\s/u.test(cursor.text[pos - 1]));
}

/** Offset of the inline comment on this line at/after `from`, or the line's content end. */
function commentBoundary(cursor, from, line) {
  for (let i = from; i < line.contentEnd; i += 1) {
    if (isCommentStart(cursor, i, line.start)) return i;
  }
  return line.contentEnd;
}

// — quoted scalars —

const DOUBLE_ESCAPES = {
  "0": "\0", a: "\u0007", b: "\b", t: "\t", n: "\n", v: "\u000B", f: "\f", r: "\r",
  e: "\u001B", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: " ",
  L: " ", P: " ",
};

function fold(rawLines) {
  // YAML flow-scalar line folding: a single break folds to a space; k
  // consecutive blank lines fold to k newlines; surrounding whitespace on
  // each physical line is trimmed before folding.
  if (rawLines.length === 1) return rawLines[0];
  let out = rawLines[0].replace(/[ \t]+$/u, "");
  for (let i = 1; i < rawLines.length; i += 1) {
    const line = rawLines[i].replace(/^[ \t]+|[ \t]+$/gu, "");
    if (line === "") { out += "\n"; continue; }
    out += (out.endsWith("\n") || out === "" ? "" : " ") + line;
  }
  return out;
}

function parseSingleQuoted(cursor, pos) {
  const { text } = cursor;
  let i = pos + 1;
  const rawLines = [""];
  for (;;) {
    if (i >= text.length) fail("unterminated single-quoted scalar", "UNTERMINATED_QUOTE", pos);
    const ch = text[i];
    if (ch === "'") {
      if (text[i + 1] === "'") { rawLines[rawLines.length - 1] += "'"; i += 2; continue; }
      i += 1;
      break;
    }
    if (ch === "\n" || ch === "\r") {
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      rawLines.push("");
      continue;
    }
    rawLines[rawLines.length - 1] += ch;
    i += 1;
  }
  return { value: fold(rawLines), end: i };
}

function parseDoubleQuoted(cursor, pos) {
  const { text } = cursor;
  let i = pos + 1;
  const rawLines = [""];
  for (;;) {
    if (i >= text.length) fail("unterminated double-quoted scalar", "UNTERMINATED_QUOTE", pos);
    const ch = text[i];
    if (ch === '"') { i += 1; break; }
    if (ch === "\n" || ch === "\r") {
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      rawLines.push("");
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "\n" || next === "\r") {
        // escaped line break: consumed with no fold at all, including the
        // next line's leading indentation.
        i += 2 + (next === "\r" && text[i + 2] === "\n" ? 1 : 0);
        while (text[i] === " " || text[i] === "\t") i += 1;
        continue;
      }
      if (next === "x" || next === "u" || next === "U") {
        const width = next === "x" ? 2 : next === "u" ? 4 : 8;
        const hex = text.slice(i + 2, i + 2 + width);
        if (hex.length < width || /[^0-9a-fA-F]/u.test(hex)) fail(`truncated \\${next} escape`, "BAD_ESCAPE", i);
        rawLines[rawLines.length - 1] += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 2 + width;
        continue;
      }
      if (Object.hasOwn(DOUBLE_ESCAPES, next ?? "")) {
        rawLines[rawLines.length - 1] += DOUBLE_ESCAPES[next];
        i += 2;
        continue;
      }
      fail(`unknown escape \\${next ?? ""}`, "BAD_ESCAPE", i);
    }
    rawLines[rawLines.length - 1] += ch;
    i += 1;
  }
  return { value: fold(rawLines), end: i };
}

function quotedScalarNode(cursor, pos, quote) {
  const { value, end } = quote === "'" ? parseSingleQuoted(cursor, pos) : parseDoubleQuoted(cursor, pos);
  const node = { kind: "scalar", value, raw: cursor.text.slice(pos, end), style: quote === "'" ? "single" : "double", start: pos, end };
  return { node, nextPos: advance(cursor, end) };
}

/**
 * The next content position after a token ending at `pos`. When nothing but
 * whitespace or a comment remains on `pos`'s own line, this moves on to the
 * next line (skipping further blank/comment lines); otherwise it returns
 * the offset of whatever unexpected content follows on the same line, for
 * the caller's own grammar check to react to.
 */
function advance(cursor, pos) {
  const idx = cursor.lineIndexAt(pos);
  const line = cursor.lines[idx];
  if (pos >= line.contentEnd) return nextContent(cursor, idx + 1);
  let i = pos;
  while (cursor.text[i] === " " || cursor.text[i] === "\t") i += 1;
  if (i >= line.contentEnd || isCommentStart(cursor, i, line.start)) return nextContent(cursor, idx + 1);
  return i;
}

// — keys —

function tryParseKey(cursor, pos) {
  const { text } = cursor;
  const line = cursor.lineAt(pos);
  const quote = text[pos];
  let keyEnd;
  let keyValue;
  if (quote === "'" || quote === '"') {
    let end;
    try {
      const result = quote === "'" ? parseSingleQuoted(cursor, pos) : parseDoubleQuoted(cursor, pos);
      end = result.end;
      keyValue = result.value;
    } catch { return null; }
    keyEnd = end;
  } else {
    if (PLAIN_START_FORBIDDEN.test(text[pos] ?? "")) return null;
    if ((text[pos] === "-" || text[pos] === "?" || text[pos] === ":") && (text[pos + 1] === undefined || /\s/u.test(text[pos + 1]))) return null;
    let i = pos;
    let colon = -1;
    while (i < line.contentEnd) {
      if (text[i] === ":" && (text[i + 1] === undefined || /[ \t]/u.test(text[i + 1]) || i + 1 === line.contentEnd)) { colon = i; break; }
      if (isCommentStart(cursor, i, line.start) && i > pos) break;
      i += 1;
    }
    if (colon === -1) return null;
    keyValue = text.slice(pos, colon).trimEnd();
    if (keyValue === "") return null;
    keyEnd = pos + keyValue.length;
  }
  let i = keyEnd;
  while (text[i] === " " || text[i] === "\t") i += 1;
  if (text[i] !== ":") return null;
  const colonPos = i;
  const afterColon = i + 1;
  const nextCh = text[afterColon];
  if (nextCh !== undefined && nextCh !== " " && nextCh !== "\t" && nextCh !== "\n" && nextCh !== "\r") return null;
  return {
    key: keyValue,
    style: quote === "'" ? "single" : quote === '"' ? "double" : "plain",
    keyStart: pos, keyEnd, colonPos, valueStart: afterColon,
  };
}

// — plain scalars —

/**
 * Scan one physical line of a plain scalar from `from` to the first comment
 * or end of line. A `: ` (or `:` at end of line) inside that span is the
 * block-mapping value indicator, not plain-scalar content — YAML's grammar
 * excludes it from a plain scalar entirely, so hitting one here is a fatal
 * error (the scalar looked like it might continue as an implicit mapping
 * key, which is never valid inline).
 */
function scanPlainSegment(cursor, from, line) {
  const { text } = cursor;
  let i = from;
  while (i < line.contentEnd) {
    if (text[i] === ":" && (text[i + 1] === undefined || /[ \t]/u.test(text[i + 1]) || i + 1 === line.contentEnd)) {
      fail("a plain scalar cannot contain ': ' — quote it or use a flow/block collection", "PLAIN_SCALAR_COLON", i);
    }
    if (isCommentStart(cursor, i, line.start) && i > from) return i;
    i += 1;
  }
  return i;
}

function parsePlainScalarNode(cursor, pos, parentIndent) {
  const { text } = cursor;
  const line = cursor.lineAt(pos);
  const boundary = scanPlainSegment(cursor, pos, line);
  const rawLines = [text.slice(pos, boundary).trimEnd()];
  let end = pos + rawLines[0].length;
  let hadComment = boundary < line.contentEnd;
  let lineIndex = cursor.lineIndexAt(pos);
  if (!hadComment) {
    for (;;) {
      // A run of blank lines only belongs to the fold (as a paragraph break)
      // if a further-indented content line follows; a comment line, a
      // dedent, or end of input means none of the run belongs to this
      // scalar, so nothing is committed (rawLines/end) until that is known.
      let probe = lineIndex + 1;
      let blanks = 0;
      while (probe < cursor.lines.length) {
        const candidate = cursor.lines[probe];
        const contentStart = indentEnd(cursor, candidate);
        if (contentStart < candidate.contentEnd) break;
        blanks += 1;
        probe += 1;
      }
      if (probe >= cursor.lines.length) break;
      const candidateLine = cursor.lines[probe];
      const contentStart = indentEnd(cursor, candidateLine);
      if (text[contentStart] === "#") break;
      if (contentStart - candidateLine.start <= parentIndent) break;
      for (let k = 0; k < blanks; k += 1) rawLines.push("");
      const candidateBoundary = scanPlainSegment(cursor, contentStart, candidateLine);
      rawLines.push(text.slice(contentStart, candidateBoundary).trimEnd());
      end = contentStart + rawLines.at(-1).length;
      lineIndex = probe;
      if (candidateBoundary < candidateLine.contentEnd) break;
    }
  }
  const raw = fold(rawLines);
  const node = { kind: "scalar", value: resolvePlainScalar(raw), raw, style: "plain", start: pos, end };
  return { node, nextPos: advance(cursor, end) };
}

// — block scalars —

function parseBlockScalarNode(cursor, pos, parentIndent) {
  const { text } = cursor;
  const indicator = text[pos]; // '|' or '>'
  let i = pos + 1;
  let chomp = "clip";
  let explicitIndent = null;
  while (i < text.length && (text[i] === "-" || text[i] === "+" || /[1-9]/u.test(text[i]))) {
    if (text[i] === "-") chomp = "strip";
    else if (text[i] === "+") chomp = "keep";
    else explicitIndent = parentIndent + Number(text[i]);
    i += 1;
  }
  const line = cursor.lineAt(pos);
  const headerRest = text.slice(i, line.contentEnd).trim();
  if (headerRest !== "" && !headerRest.startsWith("#")) fail("malformed block scalar header", "BAD_SCALAR_START", i);
  let lineIndex = cursor.lineIndexAt(pos) + 1;
  const contentLines = [];
  let blockIndent = explicitIndent;
  let end = line.end;
  // Whether the very last consumed line actually ended in a line terminator
  // — false only when the block runs to the end of the text with no final
  // newline, in which case there is no newline for any chomping mode to
  // keep, clip to one, or strip; manufacturing one would add a byte the
  // source never had.
  let finalHadNewline = true;
  while (lineIndex < cursor.lines.length) {
    const candidate = cursor.lines[lineIndex];
    const blank = candidate.start >= candidate.contentEnd;
    finalHadNewline = candidate.end > candidate.contentEnd;
    if (blank) { contentLines.push(""); end = candidate.end; lineIndex += 1; continue; }
    const contentStart = indentEnd(cursor, candidate);
    const indent = contentStart - candidate.start;
    if (blockIndent === null) {
      if (indent <= parentIndent) break;
      blockIndent = indent;
    }
    if (indent < blockIndent) break;
    contentLines.push(text.slice(candidate.start + blockIndent, candidate.contentEnd));
    end = candidate.end;
    lineIndex += 1;
  }
  // Trailing blank content lines are real trailing newlines, not noise —
  // "keep" chomping preserves every one of them, so nothing is discarded
  // before chomping decides what survives.
  let value;
  if (contentLines.length === 0) {
    value = "";
  } else if (indicator === "|") {
    value = finalHadNewline ? `${contentLines.join("\n")}\n` : contentLines.join("\n");
  } else {
    value = fold(contentLines);
    if (finalHadNewline && !value.endsWith("\n")) value += "\n";
  }
  if (chomp === "strip") value = value.replace(/\n+$/u, "");
  else if (chomp === "clip" && value.endsWith("\n")) value = value.replace(/\n+$/u, "\n");
  const node = { kind: "scalar", value, raw: text.slice(pos, end), style: indicator === "|" ? "literal" : "folded", start: pos, end };
  return { node, nextPos: nextContent(cursor, lineIndex) };
}

// — flow collections —

function skipFlowSpace(cursor, pos) {
  const { text } = cursor;
  let i = pos;
  for (;;) {
    while (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r") i += 1;
    const line = cursor.lineAt(i);
    if (isCommentStart(cursor, i, line.start)) { i = line.contentEnd; continue; }
    break;
  }
  return i;
}

function parseFlowScalar(cursor, pos) {
  const { text } = cursor;
  let i = pos;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "," || ch === "]" || ch === "}" || ch === "\n" || ch === "\r") break;
    if (ch === ":" && (text[i + 1] === undefined || /[ \t,}\]\n\r]/u.test(text[i + 1]))) break;
    if (ch === "#" && /\s/u.test(text[i - 1] ?? "")) break;
    i += 1;
  }
  const raw = text.slice(pos, i).trimEnd();
  if (raw === "") fail("expected a value inside a flow collection", "UNEXPECTED_TOKEN", pos);
  return { node: { kind: "scalar", value: resolvePlainScalar(raw), raw, style: "plain", start: pos, end: pos + raw.length }, nextPos: i };
}

function parseFlowValue(cursor, pos, depth) {
  const ch = cursor.text[pos];
  if (ch === "'" || ch === '"') {
    const { node, nextPos } = quotedScalarNode(cursor, pos, ch);
    return { node, nextPos: skipFlowSpace(cursor, nextPos ?? node.end) };
  }
  if (ch === "[" || ch === "{") return parseFlowCollection(cursor, pos, depth);
  if (ch === undefined || ch === "]" || ch === "}") fail("expected a value inside a flow collection", "UNEXPECTED_TOKEN", pos);
  const { node, nextPos } = parseFlowScalar(cursor, pos);
  return { node, nextPos: skipFlowSpace(cursor, nextPos) };
}

function parseFlowCollection(cursor, pos, depth) {
  if (depth > 2) fail("flow collections nested more than one level deep are not supported", "FLOW_TOO_DEEP", pos);
  const { text } = cursor;
  const open = text[pos];
  const close = open === "[" ? "]" : "}";
  let i = skipFlowSpace(cursor, pos + 1);
  const items = [];
  if (text[i] === close) {
    i += 1;
  } else {
    for (;;) {
      if (open === "{") {
        const keyInfoAttempt = tryFlowKey(cursor, i);
        if (keyInfoAttempt === null) fail("expected key: value inside a flow mapping", "UNEXPECTED_TOKEN", i);
        const { key, keyNode, valueStart } = keyInfoAttempt;
        const valuePos = skipFlowSpace(cursor, valueStart);
        const { node: valueNode, nextPos } = parseFlowValue(cursor, valuePos, depth + 1);
        if (items.some((item) => item.key.value === key)) fail(`keys must be unique (${key})`, "DUPLICATE_KEY", keyInfoAttempt.keyStart);
        items.push({ key: keyNode, value: valueNode, start: keyInfoAttempt.keyStart, end: valueNode.end });
        i = nextPos;
      } else {
        const { node: valueNode, nextPos } = parseFlowValue(cursor, i, depth + 1);
        items.push(valueNode);
        i = nextPos;
      }
      if (text[i] === ",") { i = skipFlowSpace(cursor, i + 1); if (text[i] === close) { i += 1; break; } continue; }
      if (text[i] === close) { i += 1; break; }
      fail(`expected ',' or '${close}' inside a flow collection`, "UNEXPECTED_TOKEN", i);
    }
  }
  const node = open === "["
    ? { kind: "seq", flow: true, items, start: pos, end: i }
    : { kind: "map", flow: true, items, start: pos, end: i };
  return { node, nextPos: advance(cursor, i) };
}

function tryFlowKey(cursor, pos) {
  const { text } = cursor;
  const quote = text[pos];
  let keyEnd;
  let key;
  if (quote === "'" || quote === '"') {
    const result = quote === "'" ? parseSingleQuoted(cursor, pos) : parseDoubleQuoted(cursor, pos);
    keyEnd = result.end;
    key = result.value;
  } else {
    let i = pos;
    while (i < text.length && !",:{}[]\n\r".includes(text[i])) i += 1;
    if (text[i] !== ":") return null;
    keyEnd = i;
    key = text.slice(pos, keyEnd).trim();
    if (key === "") return null;
  }
  let i = skipFlowSpace(cursor, keyEnd);
  if (text[i] !== ":") return null;
  return { key, keyNode: { kind: "scalar", value: key, raw: text.slice(pos, keyEnd), style: quote === "'" ? "single" : quote === '"' ? "double" : "plain", start: pos, end: keyEnd }, keyStart: pos, valueStart: i + 1 };
}

// — block collections —

function looksLikeSeqItem(cursor, pos) {
  const { text } = cursor;
  return text[pos] === "-" && (text[pos + 1] === undefined || /[ \t\n\r]/u.test(text[pos + 1]) || pos + 1 === cursor.lineAt(pos).contentEnd);
}

/**
 * Parse `pos` as a node, recording `pos` as a plain-scalar repair candidate
 * on failure — but only when this position could not itself become a fresh
 * block collection (a compact `- key: value` / nested `- - a` item). When it
 * could, the correct repair candidate is always found deeper, at the
 * innermost mapping/sequence entry that actually failed; including this
 * outer position too would let an incorrect, wider span win by starting
 * earlier on the line.
 */
function parseNodeRecordingCandidate(cursor, pos, indent, allowBlock) {
  const wouldBeCollection = allowBlock && (looksLikeSeqItem(cursor, pos) || tryParseKey(cursor, pos) !== null);
  if (wouldBeCollection) return parseNode(cursor, pos, indent, allowBlock);
  try {
    return parseNode(cursor, pos, indent, allowBlock);
  } catch (error) {
    if (error instanceof YamlSubsetError) error.candidates.push(pos);
    throw error;
  }
}

function parseBlockSequence(cursor, pos, indentColumn) {
  const items = [];
  let cur = pos;
  let end = pos;
  for (;;) {
    const line = cursor.lineAt(cur);
    let valuePos = cur + 1;
    while (cursor.text[valuePos] === " " || cursor.text[valuePos] === "\t") valuePos += 1;
    const boundary = commentBoundary(cursor, valuePos, line);
    const empty = valuePos >= line.contentEnd || valuePos >= boundary;
    let itemNode;
    let nextPos;
    if (empty) {
      const after = nextContent(cursor, cursor.lineIndexAt(cur) + 1);
      if (after !== null && cursor.col(after) > indentColumn) {
        ({ node: itemNode, nextPos } = parseNode(cursor, after, indentColumn, true));
      } else {
        itemNode = { kind: "scalar", value: null, raw: "", style: "plain", start: valuePos, end: valuePos };
        nextPos = after;
      }
    } else {
      ({ node: itemNode, nextPos } = parseNodeRecordingCandidate(cursor, valuePos, indentColumn, true));
    }
    items.push(itemNode);
    end = itemNode.end;
    cur = nextPos;
    if (cur === null) break;
    if (cursor.col(cur) !== indentColumn || !looksLikeSeqItem(cursor, cur)) break;
  }
  return { node: { kind: "seq", flow: false, items, start: pos, end }, nextPos: cur };
}

function parseBlockMapping(cursor, pos, indentColumn, firstKeyInfo) {
  const items = [];
  const seen = new Set();
  let keyInfo = firstKeyInfo;
  let end = pos;
  let resumePos = null;
  for (;;) {
    if (seen.has(keyInfo.key)) fail(`keys must be unique (${keyInfo.key})`, "DUPLICATE_KEY", keyInfo.keyStart);
    seen.add(keyInfo.key);
    const keyNode = { kind: "scalar", value: keyInfo.key, raw: cursor.text.slice(keyInfo.keyStart, keyInfo.keyEnd), style: keyInfo.style, start: keyInfo.keyStart, end: keyInfo.keyEnd };
    const { valueNode, entryEnd, nextPos } = parseMappingValue(cursor, keyInfo, indentColumn);
    items.push({ key: keyNode, value: valueNode, start: keyInfo.keyStart, end: entryEnd });
    end = entryEnd;
    resumePos = nextPos;
    if (nextPos === null) break;
    if (cursor.col(nextPos) !== indentColumn) break;
    const candidate = tryParseKey(cursor, nextPos);
    if (candidate === null) break;
    keyInfo = candidate;
  }
  return { node: { kind: "map", flow: false, items, start: pos, end }, nextPos: resumePos };
}

function parseMappingValue(cursor, keyInfo, mapIndentColumn) {
  const { text } = cursor;
  const line = cursor.lineAt(keyInfo.valueStart);
  let i = keyInfo.valueStart;
  while (text[i] === " " || text[i] === "\t") i += 1;
  const isComment = isCommentStart(cursor, i, line.start);
  if (i >= line.contentEnd || isComment) {
    const after = nextContent(cursor, cursor.lineIndexAt(keyInfo.valueStart) + 1);
    if (after !== null) {
      const col = cursor.col(after);
      if (col > mapIndentColumn) {
        const { node, nextPos } = parseNode(cursor, after, mapIndentColumn, true);
        return { valueNode: node, entryEnd: node.end, nextPos };
      }
      if (col === mapIndentColumn && looksLikeSeqItem(cursor, after)) {
        const { node, nextPos } = parseBlockSequence(cursor, after, mapIndentColumn);
        return { valueNode: node, entryEnd: node.end, nextPos };
      }
    }
    return { valueNode: { kind: "scalar", value: null, raw: "", style: "plain", start: i, end: i }, entryEnd: i, nextPos: after };
  }
  // Inline: the value continues on the key's own line, so grammar restricts
  // it to a flow node (allowBlock = false) — and this is the position a
  // scalar-quoting repair would need to quote, so failures here are recorded.
  const { node, nextPos } = parseNodeRecordingCandidate(cursor, i, mapIndentColumn, false);
  return { valueNode: node, entryEnd: node.end, nextPos };
}

/**
 * Parse whatever node begins at `pos`, given the enclosing indentation
 * `parentIndent`. `allowBlock` is true only where YAML's grammar permits a
 * fresh block collection to start here: at a document's start, on a line of
 * its own as a mapping value, or inline right after a sequence dash (the
 * `- key: value` / `- - a` compact forms). A mapping value that continues
 * inline on the same line as its key may only be a flow node — a plain,
 * quoted, or flow-collection scalar — never a fresh block mapping/sequence.
 */
function parseNode(cursor, pos, parentIndent, allowBlock) {
  const { text } = cursor;
  if (allowBlock) {
    if (looksLikeSeqItem(cursor, pos)) return parseBlockSequence(cursor, pos, cursor.col(pos));
    const keyInfo = tryParseKey(cursor, pos);
    if (keyInfo !== null) return parseBlockMapping(cursor, pos, cursor.col(pos), keyInfo);
  }
  const ch = text[pos];
  if (ch === "[" || ch === "{") return parseFlowCollection(cursor, pos, 1);
  if (ch === "'" || ch === '"') return quotedScalarNode(cursor, pos, ch);
  if (ch === "|" || ch === ">") return parseBlockScalarNode(cursor, pos, parentIndent);
  if (PLAIN_START_FORBIDDEN.test(ch ?? "")) fail(`plain scalars cannot start with '${ch}'`, "BAD_SCALAR_START", pos);
  return parsePlainScalarNode(cursor, pos, parentIndent);
}

/**
 * Parse a YAML subset document. Returns `{ contents, error }`: `contents` is
 * the top-level node (`null` for an empty document), and `error` is a
 * `YamlSubsetError` or `null`. Never throws for a document outside the
 * subset — refusal is reported through `error`, not an exception, so
 * callers (and the plain-scalar repair tool) can inspect `error.pos`.
 */
export function parseYamlSubset(text) {
  const cursor = new Cursor(text);
  let start;
  try {
    start = nextContent(cursor, 0);
  } catch (error) {
    if (error instanceof YamlSubsetError) return { contents: null, error };
    throw error;
  }
  if (start === null) return { contents: null, error: null };
  try {
    const { node, nextPos } = parseNode(cursor, start, -1, true);
    if (nextPos !== null) fail("unexpected content after the document value", "UNEXPECTED_TOKEN", nextPos);
    return { contents: node, error: null };
  } catch (error) {
    if (error instanceof YamlSubsetError) return { contents: null, error };
    throw error;
  }
}

// — node helpers —

export function isMap(node) { return !!node && typeof node === "object" && node.kind === "map"; }
export function isSeq(node) { return !!node && typeof node === "object" && node.kind === "seq"; }
export function isScalar(node) { return !!node && typeof node === "object" && node.kind === "scalar"; }
export function isCollection(node) { return isMap(node) || isSeq(node); }

/** The JS value a parsed node denotes (mirrors `Document#toJS`). */
export function nodeToJS(node) {
  if (node === null) return null;
  if (isScalar(node)) return node.value;
  if (isSeq(node)) return node.items.map(nodeToJS);
  if (isMap(node)) return Object.fromEntries(node.items.map((pair) => [pair.key.value, nodeToJS(pair.value)]));
  throw new TypeError("yaml: unrecognized node");
}

/** The child node for `key` in a map node, or `undefined`. */
export function mapGet(node, key) {
  if (!isMap(node)) return undefined;
  return node.items.find((pair) => pair.key.value === key)?.value;
}

/** Decode a single quoted-scalar token (e.g. `'foo'` or `"foo\n"`) in isolation. */
export function decodeQuotedToken(token) {
  const cursor = new Cursor(token);
  const quote = token[0];
  const result = quote === "'" ? parseSingleQuoted(cursor, 0) : parseDoubleQuoted(cursor, 0);
  if (result.end !== token.length) fail("trailing content after a quoted scalar", "UNEXPECTED_TOKEN", result.end);
  return result.value;
}
