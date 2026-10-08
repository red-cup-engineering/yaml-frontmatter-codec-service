/** Native YAML documents and an explicit, loss-refusing JSON projection. */
import { parseDocument } from "yaml";

export function parseYamlDocument(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("yaml: document must be a string");
  return parseDocument(text, { version: "1.2", intAsBigInt: true, keepSourceTokens: true, stringKeys: true, ...options });
}
export function requireYamlSyntax(document) {
  if (document.errors.length) throw new TypeError("yaml: invalid document: " + document.errors[0].message);
  return document;
}
export function jsonFromYamlDocument(document, { maxDepth = Infinity, maxNodes = Infinity } = {}) {
  requireYamlSyntax(document);
  if (document.warnings.length) throw new TypeError("yaml: unresolved tag or directive: " + document.warnings[0].message);
  let value;
  try { value = document.toJS({ maxAliasCount: 100 }); }
  catch (error) {
    if (/Excessive alias count/.test(error.message)) throw new RangeError("yaml: alias expansion exceeds 100");
    throw error;
  }
  let nodes = 0;
  const ancestors = new Set();
  function project(item, depth) {
    if (++nodes > maxNodes || depth > maxDepth) throw new RangeError("yaml: JSON projection exceeds depth or node limit");
    if (typeof item === "bigint") {
      const number = Number(item);
      if (!Number.isSafeInteger(number) || BigInt(number) !== item) throw new TypeError("yaml: integer is outside JSON's safe range");
      return number;
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) throw new TypeError("yaml: value is not representable in JSON");
    if (ancestors.has(item)) throw new TypeError("yaml: a cyclic alias graph cannot be represented in JSON");
    ancestors.add(item);
    const next = Array.isArray(item) ? item.map(child => project(child, depth + 1)) : Object.fromEntries(Object.entries(item).map(([key, child]) => [key, project(child, depth + 1)]));
    ancestors.delete(item);
    return next;
  }
  return project(value, 0);
}
