import assert from "node:assert/strict";
import test from "node:test";
import { yamlToJson, jsonToYaml, validateYamlDocument } from "../src/convert-yaml.mjs";
import { decodeYaml, deleteYamlNestedKey, mutateYamlTopLevelMapping, projectFlatScalarStringLists, decodeYamlWithSourceLocations } from "../src/index.mjs";

test("native aliases, JSON roots and types survive conversion without synthetic evidence", () => {
  assert.deepEqual(yamlToJson({text: "a: &defaults {active: true}\nb: *defaults\n"}).value, {a:{active:true},b:{active:true}});
  for (const value of [null, ["false", 3, null], false, {name:"true",list:[{name:"edge"}]}]) assert.deepEqual(yamlToJson(jsonToYaml({value})), {value});
  const value = JSON.parse('{"__proto__":"safe","constructor":3}');
  assert.deepEqual(yamlToJson(jsonToYaml({value})).value, value);
  assert.equal({}.safe, undefined);
});
test("valid YAML graphs and warnings are distinguished from lossless JSON admission", () => {
  for (const text of ["a: &x [*x]\n", "a: 9007199254740993\n", "? [a,b]\n: c\n", "a: .inf\n", "a: !custom 3\n"]) {
    assert.equal(validateYamlDocument({text}).valid, true);
    assert.throws(() => yamlToJson({text}));
  }
  assert.equal(validateYamlDocument({text:"a: !custom 3"}).warnings[0].code, "TAG_RESOLVE_FAILED");
  assert.equal(validateYamlDocument({text:"a: *missing"}).valid, false);
  assert.equal(validateYamlDocument({text:"a: 1\na: 2"}).issues[0].line, 2);
  assert.throws(() => yamlToJson({text:"a: 1\n---\nb: 2"}));
  assert.throws(() => validateYamlDocument({text:"[".repeat(66)+"1"+"]".repeat(66)}), RangeError);
  assert.throws(() => validateYamlDocument({text:"a".repeat(65537)}), RangeError);
});
test("source edits preserve anchors and following entries, and refuse broken alias references", () => {
  const source = "a: &x 'old' # keep\r\nb: *x\r\nc: |\r\n  literal\r\nd: end\r\n";
  const changed = mutateYamlTopLevelMapping(source, {mode:"set",key:"a",value:"new"});
  assert.equal(changed, source.replace("'old'", "'new'"));
  assert.deepEqual(decodeYaml(changed), {a:"new",b:"new",c:"literal\n",d:"end"});
  assert.throws(() => mutateYamlTopLevelMapping(source,{mode:"delete",keys:["a"]}), /unresolved alias/);
  assert.equal(mutateYamlTopLevelMapping(source,{mode:"delete",keys:["c"]}), source.replace("c: |\r\n  literal\r\n",""));
  for (const key of ["a","b","c"]) {
    const s="outer: {a: 1, b: 2, c: 3} # keep\nnext: exact\n";
    const result = deleteYamlNestedKey(s, ["outer",key]);
    const expected = {a:1,b:2,c:3}; delete expected[key];
    assert.deepEqual(decodeYaml(result), {outer:expected,next:"exact"});
    assert(result.endsWith(" # keep\nnext: exact\n"));
  }
  const owned = decodeYaml("__proto__: safe\n");
  assert.equal(Object.hasOwn(projectFlatScalarStringLists(owned),"__proto__"), true);
  assert.equal(Object.hasOwn(decodeYamlWithSourceLocations("__proto__: safe\n").keyLocations,"__proto__"),true);
});
