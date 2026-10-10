import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeYaml,
  decodeYamlWithSourceLocations,
  encodeYaml,
  mutateYamlTopLevelMapping,
  needsQuoteAsPlainScalar,
  projectFlatScalarStringLists,
  quoteYamlScalar,
  repairYamlPlainScalars,
} from "../src/index.mjs";

test("YAML frontmatter subset round-trips nested JSON records", () => {
  const record = {
    title: "Proof paths",
    draft: false,
    tags: ["files", "markdown"],
    owner: { name: "Red Cup", active: true },
    empty: [],
  };
  assert.deepEqual(decodeYaml(encodeYaml(record)), record);
});

test("YAML decoder preserves block scalars and ISO dates as strings", () => {
  const decoded = decodeYaml("date: 2026-07-29\nsummary: |\n  First line.\n  Second line.\n");
  assert.equal(decoded.date, "2026-07-29");
  assert.equal(decoded.summary, "First line.\nSecond line.\n");
});

// Fixtures below are drawn verbatim from real repository frontmatter that
// `decodeYaml` used to refuse (see
// content/text/triage/delta-register/Distribution/emsenn/Substack/Posts/Citing for Containment.md,
// lib/legacy/2026-07-31-lenticule-science-corpus/animating/_archive/existence/existence.md,
// and lib/legacy/2026-06-17-archive-emsenn-net/.../docs/math/acts/{negate,cap-recognition}.md),
// not invented.

test("YAML decoder accepts plain-scalar mapping keys containing spaces", () => {
  const decoded = decodeYaml('authorial voice: "[[emsenn\'s co-sourced telemetric critique essay voice]]"\n');
  assert.equal(decoded["authorial voice"], "[[emsenn's co-sourced telemetric critique essay voice]]");
});

test("YAML decoder accepts plain-scalar keys starting with a non-word character", () => {
  const decoded = decodeYaml("node: existence\nstatus: holding-exploration\n$thing: existence\n");
  assert.equal(decoded.$thing, "existence");
});

test("YAML decoder accepts legal indicator characters inside a mapping key", () => {
  assert.equal(decodeYaml("-: value\n")["-"], "value");
});

test("YAML decoder decodes \\xHH and \\uXXXX escapes in double-quoted scalars", () => {
  assert.equal(decodeYaml('symbol: "\\xAC"\n').symbol, "\u00AC");
  assert.equal(decodeYaml('symbol: "\\u22A4"\n').symbol, "\u22A4");
});

test("YAML decoder accepts standard escapes and refuses unknown escapes", () => {
  assert.equal(decodeYaml('description: "a\\tb\\bc"\n').description, "a\tb\bc");
  assert.throws(() => decodeYaml('description: "a\\qb"\n'), /invalid document/u);
});

test("YAML decoder throws on a truncated \\u escape rather than reading past it", () => {
  assert.throws(() => decodeYaml('symbol: "\\u22"\n'), TypeError);
});

test("full YAML parsing admits flow maps, block indentation, quoted keys, and multiline values", () => {
  const decoded = decodeYaml([
    "plain legal key: {kind: model, enabled: true}",
    "'single quoted key': 'it''s exact'",
    '"double quoted key": "line\\nvalue"',
    "nested:",
    "  sequence:",
    "    - one",
    "    - two",
    "literal: |",
    "  first",
    "  second",
    "",
  ].join("\n"));
  assert.deepEqual(decoded["plain legal key"], { kind: "model", enabled: true });
  assert.equal(decoded["single quoted key"], "it's exact");
  assert.equal(decoded["double quoted key"], "line\nvalue");
  assert.deepEqual(decoded.nested, { sequence: ["one", "two"] });
  assert.equal(decoded.literal, "first\nsecond\n");
});

test("full YAML parsing refuses duplicate mappings, invalid syntax, and scalar documents", () => {
  assert.throws(() => decodeYaml("name: one\nname: two\n"), /keys must be unique/u);
  assert.throws(() => decodeYaml('name: "unterminated\n'), /invalid document/u);
  assert.throws(() => decodeYaml("one scalar\n"), /must be a mapping/u);
});

test("flat projection preserves strings and string lists while omitting nested and typed values", () => {
  const decoded = decodeYaml([
    "title: Example",
    "empty:",
    "tags: [one, two]",
    "nested: {kept: false}",
    "enabled: true",
    "count: 3",
    "",
  ].join("\n"));
  assert.deepEqual(projectFlatScalarStringLists(decoded), {
    title: "Example",
    empty: "",
    tags: ["one", "two"],
  });
  assert.ok(Object.isFrozen(projectFlatScalarStringLists(decoded)));
});

test("source-location decoding reports top-level YAML key positions", () => {
  const result = decodeYamlWithSourceLocations("title: Example\nreferences:\n  source: one\ntags: [a]\n");
  assert.deepEqual(result.value, { title: "Example", references: { source: "one" }, tags: ["a"] });
  assert.deepEqual(result.keyLocations, {
    title: { line: 1, column: 1, offset: 0 },
    references: { line: 2, column: 1, offset: 15 },
    tags: { line: 4, column: 1, offset: 41 },
  });
  assert.ok(Object.isFrozen(result.keyLocations));
});

test("top-level deletion preserves every byte outside the selected entry", () => {
  const input = "name: Example\r\n# keep this\r\nrelated:\r\n  - one\r\n  - two\r\nkeywords: [one, two] # exact\r\n";
  const output = mutateYamlTopLevelMapping(input, { mode: "delete", keys: ["related"] });
  assert.equal(output, "name: Example\r\n# keep this\r\nkeywords: [one, two] # exact\r\n");
});

test("top-level rename changes only the key token despite malformed unrelated YAML", () => {
  const input = "title: Example # keep\nmalformed: [one\nbody: exact\n";
  assert.equal(
    mutateYamlTopLevelMapping(input, { mode: "rename", from: "title", to: "name" }),
    "name: Example # keep\nmalformed: [one\nbody: exact\n",
  );
});

test("top-level set replaces only the selected span", () => {
  const input = "name: old # changed span\n# untouched\nmalformed: [one\n";
  assert.equal(
    mutateYamlTopLevelMapping(input, { mode: "set", key: "name", value: "new" }),
    "name: new\n# untouched\nmalformed: [one\n",
  );
});

test("valid CST mutation selects only a quoted top-level key and preserves nested keys and complex values", () => {
  const input = [
    "# leading comment",
    "'related': remove # selected",
    "nested:",
    "  related: preserve",
    "sequence:",
    "  - related: preserve in sequence",
    "literal: |",
    "  related: preserve in block scalar",
    "name: Exact",
    "",
  ].join("\r\n");
  const expected = [
    "# leading comment",
    "nested:",
    "  related: preserve",
    "sequence:",
    "  - related: preserve in sequence",
    "literal: |",
    "  related: preserve in block scalar",
    "name: Exact",
    "",
  ].join("\r\n");
  assert.equal(mutateYamlTopLevelMapping(input, { mode: "delete", keys: ["related"] }), expected);
});

test("valid CST rename changes only the top-level key when a nested key has the same name", () => {
  const input = '"title": Top # exact\nnested:\n  title: Inner\n';
  assert.equal(
    mutateYamlTopLevelMapping(input, { mode: "rename", from: "title", to: "name" }),
    "name: Top # exact\nnested:\n  title: Inner\n",
  );
});

test("surgical mutation refuses duplicate keys and invalid lexical ambiguity", () => {
  assert.throws(
    () => mutateYamlTopLevelMapping("name: one\nname: two\n", { mode: "delete", keys: ["name"] }),
    /duplicate top-level key/u,
  );
  assert.throws(
    () => mutateYamlTopLevelMapping("title: one\nmalformed: [one\nnested:\n  title: two\n", { mode: "rename", from: "title", to: "name" }),
    /nested key title/u,
  );
  assert.throws(
    () => mutateYamlTopLevelMapping("title: one\nname: two\n", { mode: "rename", from: "title", to: "name" }),
    /already exists/u,
  );
});

test("needsQuoteAsPlainScalar and quoteYamlScalar expose encodeYaml's own quoting predicate", () => {
  assert.equal(needsQuoteAsPlainScalar("Golden Gulag: Prisons, Surplus, Crisis"), true);
  assert.equal(needsQuoteAsPlainScalar("plain title with no colon"), false);
  assert.equal(needsQuoteAsPlainScalar("@handle"), true);
  assert.equal(quoteYamlScalar("Golden Gulag: Prisons"), '"Golden Gulag: Prisons"');
  // A value this predicate flags round-trips back to the identical string once quoted.
  const value = 'Title: "with" a quote and a colon';
  assert.equal(decodeYaml(`title: ${quoteYamlScalar(value)}\n`).title, value);
});


test("AST-backed changes retain string type, quotes, comments, and list style", () => {
  const text = '# keep\r\nname: \'old\' # scalar\r\nvalues: ["false", \'it\'\'s exact\'] # list\r\ncomplex: {a: [1, 2]}\r\n';
  const named = mutateYamlTopLevelMapping(text, {mode: 'set', key: 'name', value: 'new'});
  assert.equal(named, text.replace("'old'", "'new'"));
  const listed = mutateYamlTopLevelMapping(named, {mode: 'set', key: 'values', value: ['false', "it's exact", 'true']});
  assert.deepEqual(decodeYaml(listed).values, ['false', "it's exact", 'true']);
  assert.ok(listed.includes('"false"'));
  assert.ok(listed.includes("'it''s exact'"));
  assert.ok(listed.includes('# list\r\ncomplex: {a: [1, 2]}\r\n'));
  assert.equal(mutateYamlTopLevelMapping(text, {mode:'set', key:'values', value:['false', "it's exact"]}), text);
});


test("root flow mappings mutate through the collection AST without corrupting separators", () => {
  const input = '{title: "false", nested: {title: kept}, tags: [one, two]} # exact meaning\n';
  const deleted = mutateYamlTopLevelMapping(input, {mode:'delete', keys:['title']});
  assert.deepEqual(decodeYaml(deleted), {nested:{title:'kept'}, tags:['one','two']});
  const set = mutateYamlTopLevelMapping(input, {mode:'set', key:'title', value:'true'});
  assert.deepEqual(decodeYaml(set), {title:'true',nested:{title:'kept'},tags:['one','two']});
  const renamed = mutateYamlTopLevelMapping(input, {mode:'rename', from:'title',to:'name'});
  assert.equal(decodeYaml(renamed).name, 'false');
});


test("explicit scalar repair uses parser locations and preserves comments and mixed newlines", () => {
  const source = 'title: Golden Gulag: Prisons # keep\r\nrefs:\n  - [Some: Title](url)\r\ndescription: @handle\nkept: "false"\r\n';
  const repair = repairYamlPlainScalars(source);
  assert.equal(repair.ok, true);
  assert.equal(repair.text, 'title: "Golden Gulag: Prisons" # keep\r\nrefs:\n  - "[Some: Title](url)"\r\ndescription: "@handle"\nkept: "false"\r\n');
  assert.deepEqual(decodeYaml(repair.text), {title:'Golden Gulag: Prisons',refs:['[Some: Title](url)'],description:'@handle',kept:'false'});
  assert.equal(repair.changes.length, 3);
  assert.deepEqual(repairYamlPlainScalars(repair.text), {ok:true,text:repair.text,changes:[]});
});

test("explicit scalar repair refuses structural defects and does not return partial rewrites", () => {
  for (const source of ['title: [one\n', 'title: one\ntitle: two\n', 'title: A: B\nnext: [broken\n', 'just prose\n']) {
    const result = repairYamlPlainScalars(source);
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, 'text'), false);
  }
  const nested = repairYamlPlainScalars('items:\n  - title: A: B\n');
  assert.equal(nested.ok, true);
  assert.deepEqual(decodeYaml(nested.text), {items:[{title:'A: B'}]});
  const link = repairYamlPlainScalars('items:\n  - title: [Some: Title](url)\n');
  assert.equal(link.ok, true);
  assert.deepEqual(decodeYaml(link.text), {items:[{title:'[Some: Title](url)'}]});
});
