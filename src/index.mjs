/** YAML mapping projection and source-preserving edits. Markdown owns its fences. */
import { isObjectRecord, requireJsonValue } from "@red-cup-engineering/json-services-section";
import { isMap, isScalar, isSeq, visit } from "yaml";
import { parseYamlDocument, jsonFromYamlDocument, requireYamlSyntax } from "./document.mjs";
import { isDeepStrictEqual } from "node:util";
const KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
/**
 * Whether a plain (unquoted) YAML scalar would misparse and therefore must be
 * quoted. Exported so a frontmatter repair tool can quote only the values
 * that actually need it, rather than reimplementing this predicate.
 */
export function needsQuoteAsPlainScalar(text) {
    return needsQuote(text);
}
/** Quote a scalar the same way `encodeYaml` would, escaping as `encodeYaml` does. */
export function quoteYamlScalar(text) {
    return quoteString(text);
}
/** Decode a YAML head (fence-free text) into a frozen JSON record. */
export function decodeYaml(text) {
    return decodeYamlDocument(text).record;
}
/** Parse a native YAML document and admit its JSON mapping projection. */
export function decodeYamlDocument(text, lineCounter) {
    const document = parseYamlDocument(text, { lineCounter });
    requireYamlSyntax(document);
    const value = document.contents === null ? {} : jsonFromYamlDocument(document);
    if (!isObjectRecord(value)) throw new TypeError("yaml: document must be a mapping");
    return Object.freeze({ document, record: requireJsonValue(value, "yaml document") });
}
/** 1-indexed {line, column} of `offset` within `text`. */
function linePosition(text, offset) {
    let line = 1;
    let lastNewline = -1;
    for (let i = 0; i < offset; i += 1) {
        if (text[i] === "\n") {
            line += 1;
            lastNewline = i;
        }
    }
    return { line, column: offset - lastNewline };
}
/** Decode a YAML mapping and locate each top-level key in the original text. */
export function decodeYamlWithSourceLocations(text) {
    const { document, record } = decodeYamlDocument(text);
    const keyLocations = {};
    if (isMap(document.contents)) {
        for (const pair of document.contents.items) {
            const key = pair.key.value;
            const offset = pair.key.range[0];
            if (typeof key !== "string" || offset === undefined)
                continue;
            const { line, column } = linePosition(text, offset);
            Object.defineProperty(keyLocations, key, { value: Object.freeze({ line, column, offset }), enumerable: true });
        }
    }
    return Object.freeze({ value: record, keyLocations: Object.freeze(keyLocations) });
}
/**
 * Project a full YAML mapping onto the older flat metadata contract.
 * Strings and string lists survive, null means an empty scalar, and nested or
 * typed values are omitted instead of being reinterpreted as strings.
 */
export function projectFlatScalarStringLists(record) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
        throw new TypeError("yaml: flat projection requires a mapping");
    }
    const projected = {};
    for (const [key, value] of Object.entries(record)) {
        if (value === null) {
            Object.defineProperty(projected, key, { value: "", enumerable: true });
        }
        else if (typeof value === "string") {
            Object.defineProperty(projected, key, { value, enumerable: true });
        }
        else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
            Object.defineProperty(projected, key, { value: Object.freeze([...value]), enumerable: true });
        }
    }
    return Object.freeze(projected);
}
/**
 * Change one or more top-level mapping fields without serializing unrelated
 * YAML. Valid maps use parsed node ranges so nested same-name keys remain
 * untouched. Invalid YAML falls back to a conservative lexical assay that
 * refuses duplicate targets, nested target collisions, and ambiguous keys.
 */
export function mutateYamlTopLevelMapping(text, mutation) {
    const next = mutateTopLevel(text, mutation);
    return checkedEdit(text, next);
}
function mutateTopLevel(text, mutation) {
    if (typeof text !== "string")
        throw new TypeError("yaml: document must be a string");
    if (mutation === null || typeof mutation !== "object")
        throw new TypeError("yaml: mutation must be an object");
    const keys = mutation.mode === "delete" ? mutation.keys : mutation.mode === "rename" ? [mutation.from, mutation.to] : [mutation.key];
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || key.length === 0)) {
        throw new TypeError("yaml: mutation keys must be nonempty strings");
    }
    const uniqueTargets = [...new Set(keys)];
    const parsedRoot = parseYamlDocument(text);
    if (parsedRoot.errors.length === 0 && isMap(parsedRoot.contents) && parsedRoot.contents.flow === true) {
        // A flow mapping is one syntactic carrier: commas and braces belong to
        // its collection, so field mutation is resolved semantically (through
        // the decoded record) and the whole collection is re-emitted.
        return mutateFlowMapping(text, mutation);
    }
    const { entries, nestedKeys } = scanTopLevelMapping(text);
    for (const key of uniqueTargets) {
        const matches = entries.filter((entry) => entry.key === key);
        if (matches.length > 1)
            throw new TypeError(`yaml: duplicate top-level key ${key}`);
        if (nestedKeys.has(key))
            throw new TypeError(`yaml: nested key ${key} makes top-level mutation ambiguous`);
    }
    if (mutation.mode === "delete") {
        const spans = entries.filter(({ key }) => uniqueTargets.includes(key)).sort((left, right) => right.start - left.start);
        return spans.reduce((result, { start, end }) => `${result.slice(0, start)}${result.slice(end)}`, text);
    }
    if (mutation.mode === "rename") {
        const source = entries.find(({ key }) => key === mutation.from);
        if (source === undefined)
            return text;
        if (entries.some(({ key }) => key === mutation.to))
            throw new TypeError(`yaml: top-level key ${mutation.to} already exists`);
        return `${text.slice(0, source.keyStart)}${renderMappingKey(mutation.to)}${text.slice(source.keyEnd)}`;
    }
    const existing = entries.find(({ key }) => key === mutation.key);
    if (existing !== undefined) {
        const parsed = parsedTopLevelMapping(text);
        if (parsed !== null && isDeepStrictEqual(decodeYaml(text)[mutation.key], mutation.value))
            return text;
    }
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    // renderChangedPair may return text that already contains raw-sliced
    // "\r\n" bytes from the original (the style-reuse paths splice original
    // source); normalize *any* line ending to `newline` rather than blindly
    // inserting a "\r" before every "\n", which would double an existing one.
    const rendered = renderChangedPair(text, mutation).replace(/\r?\n/gu, newline);
    if (existing !== undefined)
        return `${text.slice(0, existing.start)}${rendered}${text.slice(existing.end)}`;
    const before = entries.find(({ key }) => key === mutation.beforeKey);
    if (before !== undefined)
        return `${text.slice(0, before.start)}${rendered}${text.slice(before.start)}`;
    const separator = text.length === 0 || text.endsWith("\n") || text.endsWith("\r") ? "" : newline;
    return `${text}${separator}${rendered}`;
}
/**
 * Delete one key at a nested mapping-key path (`path.length > 1`; a single
 * top-level key is `mutateYamlTopLevelMapping`'s job), retaining every byte
 * outside the deleted entry. When deleting the key would leave an
 * intermediate parent mapping empty, that empty parent is removed too —
 * walking up the path — rather than left behind as `key:` with no value.
 * A path segment that does not exist is a no-op; one that exists but is not
 * itself a mapping (when more path remains) is refused.
 */
export function deleteYamlNestedKey(text, path) {
    if (typeof text !== "string")
        throw new TypeError("yaml: document must be a string");
    if (!Array.isArray(path) || path.length === 0 || path.some((key) => typeof key !== "string" || key.length === 0)) {
        throw new TypeError("yaml: path must be a nonempty string array");
    }
    if (path.length === 1)
        return mutateYamlTopLevelMapping(text, { mode: "delete", keys: path });
    const parsed = parseYamlDocument(text);
    if (parsed.errors.length !== 0 || !isMap(parsed.contents))
        throw new TypeError("yaml: document must be a valid YAML mapping");
    const maps = [parsed.contents];
    const pairs = [];
    let current = parsed.contents;
    for (let index = 0; index < path.length; index += 1) {
        const key = path[index];
        const pair = current.items.find((item) => item.key.value === key);
        if (pair === undefined)
            return text;
        pairs.push(pair);
        if (index === path.length - 1)
            break;
        if (!isMap(pair.value))
            throw new TypeError(`yaml: key ${path.slice(0, pairs.length).join("/")} is not a mapping`);
        current = pair.value;
        maps.push(current);
    }
    // Walk outward from the leaf: an intermediate mapping that would become
    // empty is itself deleted instead, so the actual deletion target is the
    // outermost ancestor pair left with no siblings.
    let deletion = pairs.length - 1;
    for (let index = maps.length - 1; index > 0 && maps[index].items.length === 1; index -= 1)
        deletion = index - 1;
    const target = pairs[deletion];
    const parent = maps[deletion];
    if (parent.flow) {
        const index = parent.items.indexOf(target);
        const following = parent.items[index + 1];
        const comma = target.srcToken?.start.find(token => token.type === "comma");
        const start = following ? target.key.range[0] : comma?.offset ?? target.key.range[0];
        const end = following ? following.key.range[0] : target.value?.range[1] ?? target.key.range[1];
        return checkedEdit(text, text.slice(0, start) + text.slice(end));
    }
    // A nested entry's own leading indentation belongs to no other entry;
    // deleting from the key's own start (rather than its line's start)
    // would strand that indentation as a prefix glued onto whatever
    // follows. Top-level entries have no indentation, so this is a no-op
    // there.
    const start = target.key.range[0] - columnAt(text, target.key.range[0]);
    const end = pairEndOffset(text, target);
    if (typeof start !== "number" || end < start || end > text.length) {
        throw new TypeError(`yaml: cannot locate key ${path.join("/")} in source`);
    }
    return checkedEdit(text, `${text.slice(0, start)}${text.slice(end)}`);
}
/** Column (0-indexed) of `offset` on its own line. */
function columnAt(text, offset) {
    let i = offset;
    while (i > 0 && text[i - 1] !== "\n")
        i -= 1;
    return offset - i;
}
/** Mutate a root-level *flow* mapping (`{a: 1, ...}`) through its decoded record. */
function mutateFlowMapping(text, mutation) {
    const record = decodeYaml(text);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    if (mutation.mode === "delete") {
        if (!mutation.keys.some((key) => Object.hasOwn(record, key)))
            return text;
        const next = { ...record };
        for (const key of mutation.keys)
            delete next[key];
        return `${encodeFlowMapping(next)}${newline}`;
    }
    if (mutation.mode === "rename") {
        if (!Object.hasOwn(record, mutation.from) || mutation.from === mutation.to)
            return text;
        if (Object.hasOwn(record, mutation.to))
            throw new TypeError(`yaml: top-level key ${mutation.to} already exists`);
        const next = {};
        for (const [key, value] of Object.entries(record))
            Object.defineProperty(next, key === mutation.from ? mutation.to : key, { value, enumerable: true });
        return `${encodeFlowMapping(next)}${newline}`;
    }
    if (isDeepStrictEqual(record[mutation.key], mutation.value))
        return text;
    const next = { ...record, [mutation.key]: mutation.value };
    return `${encodeFlowMapping(next)}${newline}`;
}
/** Serialize only the changed pair, reusing the previous entry's quote/flow style wherever the new value still fits it. */
function renderChangedPair(text, mutation) {
    const parsed = parseYamlDocument(text);
    if (parsed.errors.length !== 0 || (parsed.contents !== null && !isMap(parsed.contents))) {
        return encodeYaml({ [mutation.key]: mutation.value });
    }
    const map = parsed.contents;
    const pair = map === null ? undefined : map.items.find((item) => item.key.value === mutation.key);
    if (pair === undefined) {
        return renderEntryDefault(mutation.key, mutation.value, mutation.flow);
    }
    const previous = pair.value;
    const value = mutation.value;
    // The parsed pair's own `.end` stops at the value's content; a
    // byte-preserving splice needs the entry's true end — through any
    // trailing inline comment and the line's own terminator — so the tail
    // slice below carries the comment and newline forward untouched.
    const pairEnd = pairEndOffset(text, pair);
    if (isScalar(previous) && (value === null || typeof value !== "object")) {
        const reused = renderScalarReuse(previous, value);
        const rendered = reused ?? encodeScalar(value);
        return `${text.slice(pair.key.range[0], previous.range[0])}${rendered}${text.slice(previous.range[1], pairEnd)}`;
    }
    if (isSeq(previous) && Array.isArray(value)) {
        const keyIndent = columnAt(text, pair.key.range[0]);
        const rendered = renderChangedArray(text, previous, value, keyIndent, mutation.flow);
        return `${text.slice(pair.key.range[0], previous.range[0])}${rendered}${text.slice(previous.range[1], pairEnd)}`;
    }
    // A type change (scalar <-> collection) or a record value: re-render the
    // whole entry with the default projection rather than guess a splice.
    return renderEntryDefault(mutation.key, value, mutation.flow);
}
/** Reuse `previous`'s quote style for a new string scalar, or `null` to fall back to default encoding. */
function renderScalarReuse(previous, value) {
    if (typeof value !== "string" || value.includes("\n"))
        return null;
    if (previous.type === "QUOTE_SINGLE" || previous.type === "QUOTE_DOUBLE") {
        // A quote the previous value only wore by the author's stylistic
        // choice (it did not need quoting) stays, whatever the new value is —
        // that choice was never about the value's shape. A quote the previous
        // value *required* (e.g. it started with a reserved indicator) is not
        // carried forward once the new value no longer needs it, so a value
        // like a bare date is not left wearing quotes it has no reason for.
        if (needsQuote(previous.value) && !needsQuote(value))
            return null;
        return previous.type === "QUOTE_SINGLE" ? `'${value.replaceAll("'", "''")}'` : quoteString(value);
    }
    if (previous.type === "PLAIN" && !needsQuote(value))
        return value;
    return null;
}
/** Render a changed array value, reusing retained items' exact source text and the previous flow/block style. */
function renderChangedArray(text, previous, values, keyIndent, flowOverride) {
    if (values.length === 0)
        return "[]";
    const useFlow = flowOverride !== undefined ? flowOverride : (isSeq(previous) ? previous.flow : false);
    const previousItems = isSeq(previous) ? previous.items : [];
    const rawFor = (value) => {
        const retained = previousItems.find((old) => isScalar(old) && isDeepStrictEqual(old.value, value));
        return retained ? text.slice(retained.range[0], retained.range[1]) : encodeScalar(value);
    };
    if (useFlow)
        return `[ ${values.map(rawFor).join(", ")} ]`;
    const pad = " ".repeat(keyIndent + 2);
    return values.map((value) => `- ${rawFor(value)}`).join(`\n${pad}`);
}
/** Default rendering for a brand-new key, or a value whose previous style cannot be reused. */
function renderEntryDefault(key, value, flow) {
    // Always ends with its own trailing newline: callers either splice this
    // in place of an entry that owned the original trailing newline (a
    // type-changing set) or insert it directly before a sibling key, and
    // either way nothing else supplies the line break this entry needs.
    if (flow === true && Array.isArray(value) && value.length > 0) {
        return `${renderMappingKey(key)}: ${encodeFlowScalarOrNested(value)}\n`;
    }
    const lines = [];
    encodeEntry(lines, key, value, 0, key);
    return `${lines.join("\n")}\n`;
}
function encodeFlowScalarOrNested(value) {
    if (Array.isArray(value)) {
        if (value.length === 0)
            return "[]";
        return `[ ${value.map(encodeFlowScalarOrNested).join(", ")} ]`;
    }
    if (isObjectRecord(value))
        return encodeFlowMapping(value);
    return encodeScalar(value);
}
function encodeFlowMapping(record) {
    const entries = Object.entries(record).filter(([, value]) => value !== undefined);
    if (entries.length === 0)
        return "{}";
    return `{ ${entries.map(([key, value]) => `${renderMappingKey(key)}: ${encodeFlowScalarOrNested(value)}`).join(", ")} }`;
}
function scanTopLevelMapping(text) {
    const parsed = parsedTopLevelMapping(text);
    if (parsed !== null)
        return parsed;
    return scanLexicalTopLevelMapping(text);
}
/**
 * Select exact top-level pairs from a valid YAML map. Nested same-name keys
 * are not candidates and therefore remain byte-identical. Invalid documents
 * deliberately fall through to the conservative lexical refusal path.
 */
function parsedTopLevelMapping(text) {
    const parsed = parseYamlDocument(text);
    if (parsed.errors.length !== 0 || !isMap(parsed.contents))
        return null;
    const entries = parsed.contents.items.map((pair) => Object.freeze({
        key: pair.key.value, keyStart: pair.key.range[0], keyEnd: pair.key.range[1], start: pair.key.range[0], end: pairEndOffset(text, pair),
    }));
    return Object.freeze({ entries: Object.freeze(entries), nestedKeys: new Set() });
}
/**
 * A parsed pair's `.end` stops at its value's own content; extend it through
 * any trailing inline comment and the line's terminator, so a byte-
 * preserving delete or splice removes the whole line rather than leaving a
 * stray comment or a doubled line break behind.
 */
function pairEndOffset(text, pair) {
    const end = pair.value?.range?.[2] ?? pair.key.range[2];
    return end > 0 && text[end - 1] === "\n" ? end : entryEndWithTrailer(text, end);
}
function checkedEdit(before, after) {
    const original = parseYamlDocument(before);
    if (!original.errors.length) {
        const result = requireYamlSyntax(parseYamlDocument(after));
        visit(result, { Alias(key, node) {
            if (!node.resolve(result)) throw new TypeError(`yaml: edit leaves unresolved alias ${node.source}`);
        } });
    }
    return after;
}
function entryEndWithTrailer(text, valueEnd) {
    const lines = sourceLines(text);
    if (lines.length === 0)
        return text.length;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid].start <= valueEnd)
            lo = mid;
        else
            hi = mid - 1;
    }
    return lines[lo].end;
}
function scanLexicalTopLevelMapping(text) {
    const lines = sourceLines(text);
    const starts = [];
    const nestedKeys = new Set();
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        if (line === undefined || line.content.trim() === "" || line.content.trimStart().startsWith("#"))
            continue;
        const indent = line.content.length - line.content.trimStart().length;
        const parsed = parseMappingKey(line.content.slice(indent));
        if (parsed === null)
            continue;
        if (indent > 0) {
            nestedKeys.add(parsed.key);
            continue;
        }
        starts.push({
            key: parsed.key,
            keyStart: line.start + parsed.start,
            keyEnd: line.start + parsed.end,
            start: line.start,
            lineIndex,
        });
    }
    const entries = starts.map((entry) => {
        let end = lines[entry.lineIndex]?.end ?? text.length;
        for (let index = entry.lineIndex + 1; index < lines.length; index += 1) {
            const line = lines[index];
            if (line === undefined)
                break;
            const trimmed = line.content.trim();
            const indent = line.content.length - line.content.trimStart().length;
            if (trimmed === "" || (indent === 0 && trimmed.startsWith("#")))
                break;
            if (indent === 0 && parseMappingKey(line.content) !== null)
                break;
            if (indent === 0 && !line.content.startsWith("-") && !line.content.startsWith("? "))
                break;
            end = line.end;
        }
        return Object.freeze({ key: entry.key, keyStart: entry.keyStart, keyEnd: entry.keyEnd, start: entry.start, end });
    });
    return Object.freeze({ entries: Object.freeze(entries), nestedKeys });
}
function sourceLines(text) {
    const lines = [];
    const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/gu;
    for (const match of text.matchAll(pattern)) {
        if (match[0] === "")
            continue;
        const start = match.index;
        const content = match[0].replace(/(?:\r\n|\n|\r)$/u, "");
        lines.push(Object.freeze({ start, contentEnd: start + content.length, end: start + match[0].length, content }));
    }
    return Object.freeze(lines);
}
function parseMappingKey(line) {
    if (line.startsWith("'") || line.startsWith('"')) {
        const quote = line[0];
        let end = 1;
        while (end < line.length) {
            if (quote === "'" && line[end] === "'" && line[end + 1] === "'") {
                end += 2;
                continue;
            }
            if (line[end] === quote && (quote === "'" || line[end - 1] !== "\\"))
                break;
            end += 1;
        }
        if (end >= line.length)
            return null;
        const separator = line.slice(end + 1).match(/^\s*:/u);
        if (separator === null)
            return null;
        const token = line.slice(0, end + 1);
        let key;
        try {
            key = jsonFromYamlDocument(requireYamlSyntax(parseYamlDocument(token)));
        }
        catch {
            return null;
        }
        return Object.freeze({ key, start: 0, end: end + 1 });
    }
    for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== ":")
            continue;
        const next = line[index + 1];
        if (next !== undefined && !/[ \t]/u.test(next))
            continue;
        const key = line.slice(0, index).trimEnd();
        if (key === "" || /^[\-?:](?:\s|$)/u.test(key))
            return null;
        return Object.freeze({ key, start: 0, end: key.length });
    }
    return null;
}
function renderMappingKey(key) {
    if (isPlainKey(key) && !key.includes(":"))
        return key;
    return JSON.stringify(key);
}
function isPlainKey(key) {
    const document = parseYamlDocument(`{${key}: null}`);
    const pairs = document.contents?.items;
    return !document.errors.length && isMap(document.contents) && pairs.length === 1 && isScalar(pairs[0].key) && pairs[0].key.type === "PLAIN" && pairs[0].key.value === key;
}
/** Encode a JSON record as YAML head text (fence-free, trailing newline). */
export function encodeYaml(record) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
        throw new TypeError("yaml: document must be a plain record");
    }
    const lines = [];
    for (const [key, value] of Object.entries(record)) {
        if (value === undefined)
            continue;
        encodeEntry(lines, key, value, 0, key);
    }
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
// — encoding —
export function encodeEntry(lines, rawKey, value, indent, where) {
    const key = KEY_PATTERN.test(rawKey) ? rawKey : quoteString(rawKey);
    const pad = " ".repeat(indent);
    if (isObjectRecord(value)) {
        lines.push(`${pad}${key}:`);
        for (const [childKey, child] of Object.entries(value)) {
            if (child === undefined)
                continue;
            encodeEntry(lines, childKey, child, indent + 2, `${where}.${childKey}`);
        }
        return;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            lines.push(`${pad}${key}: []`);
            return;
        }
        lines.push(`${pad}${key}:`);
        encodeSequence(lines, value, indent + 2, where);
        return;
    }
    if (typeof value === "string" && value.includes("\n")) {
        encodeBlockScalar(lines, `${pad}${key}:`, value, indent + 2);
        return;
    }
    lines.push(`${pad}${key}: ${encodeScalar(value)}`);
}
export function encodeSequence(lines, value, indent, where) {
    const pad = " ".repeat(indent);
    for (const [index, item] of value.entries()) {
        const itemWhere = `${where}[${index}]`;
        if (isObjectRecord(item)) {
            encodeSequenceMapItem(lines, item, indent, itemWhere);
            continue;
        }
        if (Array.isArray(item)) {
            lines.push(`${pad}- ${encodeInlineArray(item, itemWhere)}`);
            continue;
        }
        if (typeof item === "string" && item.includes("\n")) {
            throw new TypeError(`${itemWhere}: multi-line strings are not encodable as sequence items`);
        }
        lines.push(`${pad}- ${encodeScalar(item)}`);
    }
}
function encodeSequenceMapItem(lines, item, indent, where) {
    const entries = Object.entries(item).filter(([, child]) => child !== undefined);
    if (entries.length === 0)
        throw new TypeError(`${where}: sequence map items must have at least one entry`);
    const dash = `${" ".repeat(indent)}- `;
    const before = lines.length;
    for (const [key, child] of entries) {
        encodeEntry(lines, key, child, indent + 2, `${where}.${key}`);
    }
    const first = lines[before];
    if (first !== undefined)
        lines[before] = `${dash}${first.slice(indent + 2)}`;
}
function encodeInlineArray(value, where) {
    const items = value.map((item, index) => {
        if (isObjectRecord(item))
            throw new TypeError(`${where}[${index}]: records inside nested arrays are not encodable`);
        if (Array.isArray(item))
            return encodeInlineArray(item, `${where}[${index}]`);
        if (typeof item === "string" && item.includes("\n"))
            throw new TypeError(`${where}[${index}]: multi-line strings are not encodable inline`);
        return encodeScalar(item);
    });
    return `[${items.join(", ")}]`;
}
function encodeBlockScalar(lines, keyLine, value, indent) {
    const pad = " ".repeat(indent);
    const chomp = value.endsWith("\n") ? "" : "-";
    const body = value.endsWith("\n") ? value.slice(0, -1) : value;
    lines.push(`${keyLine} |${chomp}`);
    for (const line of body.split("\n")) {
        lines.push(line === "" ? "" : `${pad}${line}`);
    }
}
function encodeScalar(value) {
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new TypeError("yaml: numbers must be finite");
        return String(value);
    }
    if (typeof value !== "string")
        throw new TypeError("yaml: scalars are strings, numbers, booleans, or null");
    return needsQuote(value) ? quoteString(value) : value;
}
export function needsQuote(text) {
    if (typeof text !== "string" || text === "" || text !== text.trim()) return true;
    const document = parseYamlDocument(text);
    return document.errors.length !== 0 || document.warnings.length !== 0 || !isScalar(document.contents) || document.contents.type !== "PLAIN" || document.contents.value !== text;
}
function quoteString(text) { return JSON.stringify(text); }
const REPAIRABLE_ERROR_CODES = new Set(["BLOCK_AS_IMPLICIT_KEY", "BAD_SCALAR_START", "UNEXPECTED_TOKEN"]);
/** First inline comment following a prospective plain scalar. */
function findCommentStart(text, from, to) {
    for (let i = from; i < to; i++) if (text[i] === "#" && (i === from || /\s/u.test(text[i - 1]))) return i;
    return to;
}
/** Explicit repair only: quote a parser-located scalar, never infer broken collections. */
export function repairYamlPlainScalars(source) {
    if (typeof source !== "string") throw new TypeError("yaml: document must be a string");
    let text = source;
    const changes = [];
    for (let iteration = 0; iteration < 50; iteration++) {
        const parsed = parseYamlDocument(text);
        const error = parsed.errors[0];
        if (!error) {
            try { decodeYaml(text); }
            catch (cause) { return { ok: false, reason: cause.message, line: null }; }
            return { ok: true, text, changes };
        }
        const offset = error.pos[0];
        const lineNumber = linePosition(text, offset).line;
        const line = sourceLines(text)[lineNumber - 1];
        const refused = { ok: false, reason: error.message, line: lineNumber };
        if (!line || !REPAIRABLE_ERROR_CODES.has(error.code)) return refused;
        // Native AST ranges identify value starts even when composition reports
        // an error. They avoid maintaining a second YAML grammar for repair.
        const candidates = [];
        visit(parsed, (key, node) => {
            if (key !== "key" && node?.range && node.range[0] >= line.start && node.range[0] <= offset && node.range[0] < line.contentEnd) candidates.push(node.range[0]);
        });
        const eligible = candidates.filter(start => {
            const prefix = text.slice(line.start, start);
            return /(?:^\s*-\s+|:\s+)$/.test(prefix);
        });
        if (!eligible.length) return refused;
        const linkStart = eligible.find(start => /^\[[^\r\n]*\]\([^\r\n]*\)$/.test(text.slice(start, findCommentStart(text, start, line.contentEnd)).trimEnd()));
        if (error.code === "UNEXPECTED_TOKEN" && linkStart === undefined) return refused;
        const start = error.code === "UNEXPECTED_TOKEN" ? linkStart : eligible.includes(offset) ? offset : Math.min(...eligible);
        const comment = findCommentStart(text, start, line.contentEnd);
        const value = text.slice(start, comment).trimEnd();
        if (!value || /^["']/.test(value) || !needsQuote(value)) return refused;
        if (/^[\[{]/.test(value) && !(error.code === "UNEXPECTED_TOKEN" && /^\[[^\r\n]*\]\([^\r\n]*\)$/.test(value))) return refused;
        const replacement = quoteYamlScalar(value);
        const next = text.slice(0, start) + replacement + text.slice(start + value.length);
        changes.push({ line: lineNumber, before: line.content, after: text.slice(line.start, start) + replacement + text.slice(start + value.length, line.contentEnd) });
        text = next;
    }
    return { ok: false, reason: "did not converge within 50 iterations", line: null };
}
