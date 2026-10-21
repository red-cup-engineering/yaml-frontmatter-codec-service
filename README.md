# YAML conversion and source edits

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

The native yaml 2.9.1 parser owns grammar, document directives, anchors, tags,
source ranges and diagnostics. The hand-written restricted parser is removed.
Markdown consumers still own frontmatter fences and body bytes.

The mapping API admits a finite JSON record: scalar keys become strings,
safe integer values remain numbers, aliases resolve, and cycles, unresolved
tags, nonfinite values and unsafe integers are refused. Existing canonical
record serialization and source-preserving field edits remain available.
Edits to a valid document cannot leave an unresolved alias. Malformed source
retains the conservative lexical edit and explicit scalar-repair paths.

The ./convert-yaml entry exposes yamlToJson({text}), jsonToYaml({value}) and
validateYamlDocument({text}). Conversion accepts all JSON root kinds.
Validation reports the actual declared YAML version (1.2 by default), syntax
and unresolved-alias issues, and separate tag/directive warnings. A valid YAML
graph need not be representable in JSON.

Paid operations admit 65536 UTF-8 bytes, depth 64, 8192 syntax/projection nodes
and at most 100 aliases. JSON conversion also limits arrays to 4096 items and
refuses excessive alias expansion. Resource refusals are not syntax verdicts.
No upstream compute, model or filesystem access is needed.
