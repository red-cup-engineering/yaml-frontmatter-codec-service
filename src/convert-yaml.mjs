/** Bounded native YAML diagnostics and YAML/JSON conversion, without I/O. */
import { Document, isAlias, isCollection, visit } from "yaml";
import { canonicalizeJson, JSON_RESOURCE_ENVELOPE } from "@red-cup-engineering/json-services-section/canonical-json";
import { parseYamlDocument, jsonFromYamlDocument } from "./document.mjs";

const LIMIT = 65536;
const envelope = Object.freeze({ ...JSON_RESOURCE_ENVELOPE, maxSourceBytes: LIMIT, maxCanonicalBytes: LIMIT, maxNodes: 8192, maxArrayLength: 4096 });
function request(body, key) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, key) || Object.keys(body).some(k => k !== key)) throw new TypeError(`request requires exactly ${key}`);
  return body[key];
}
function textFrom(body) {
  const text = request(body, "text");
  if (typeof text !== "string" || !text.isWellFormed()) throw new TypeError("text must be well-formed Unicode YAML text");
  if (new TextEncoder().encode(text).byteLength > LIMIT) throw new RangeError(`YAML text exceeds ${LIMIT} bytes`);
  return text;
}
function boundedDocument(text, stringKeys) {
  const document = parseYamlDocument(text, { stringKeys });
  let nodes = 0, aliases = 0;
  visit(document, (key, node, path) => {
    if (node && (++nodes > 8192 || path.filter(isCollection).length > 64)) throw new RangeError("YAML syntax tree exceeds depth 64 or 8192 nodes");
    if (isAlias(node) && ++aliases > 100) throw new RangeError("YAML document exceeds 100 aliases");
  });
  return document;
}
export function yamlToJson(body) {
  const document = boundedDocument(textFrom(body), true);
  return { value: canonicalizeJson(jsonFromYamlDocument(document, { maxDepth: 64, maxNodes: 8192 }), envelope).value };
}
export function jsonToYaml(body) {
  const value = canonicalizeJson(request(body, "value"), envelope).value;
  const text = new Document(value, { version: "1.2" }).toString({ lineWidth: 0 });
  if (new TextEncoder().encode(text).byteLength > LIMIT) throw new RangeError(`YAML output exceeds ${LIMIT} bytes`);
  return { text };
}
export function validateYamlDocument(body) {
  const document = boundedDocument(textFrom(body), false);
  const issues = document.errors.map(error => diagnostic(error));
  // YAML graphs may be cyclic and are valid syntax. An alias without a
  // preceding anchor is not: resolve it without expanding the graph.
  visit(document, { Alias(key, node) {
    if (!node.resolve(document)) issues.push({ code: "UNRESOLVED_ALIAS", message: `Alias ${node.source} has no preceding anchor`, line: null, column: null });
  } });
  return {
    valid: issues.length === 0,
    standard: `YAML ${document.directives.yaml.version}`,
    issues: issues.slice(0, 64),
    warnings: document.warnings.slice(0, 64).map(diagnostic)
  };
}
function diagnostic(error) {
  return { code: error.code, message: error.message.split("\n")[0].slice(0, 1024), line: error.linePos?.[0]?.line ?? null, column: error.linePos?.[0]?.col ?? null };
}
