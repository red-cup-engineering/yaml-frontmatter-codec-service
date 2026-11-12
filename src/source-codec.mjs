import { decodeUtf8Source, defineSourceCodec, encodeUtf8Source } from "@red-cup-engineering/signcell/source-codec";
import { decodeYaml, encodeYaml } from "./index.mjs";
import { jsonToYaml, yamlToJson } from "./convert-yaml.mjs";

export const yamlJsonSourceCodec = defineSourceCodec({
  id: "yaml.json/v1", mediaType: "application/yaml", maxBytes: 65536, valueIdentity: "exact",
  decode: bytes => yamlToJson({ text: decodeUtf8Source(bytes) }).value,
  encode: value => encodeUtf8Source(jsonToYaml({ value }).text),
});

export const yamlFrontmatterSourceCodec = defineSourceCodec({
  id: "yaml.frontmatter/v1", mediaType: "application/yaml", maxBytes: 65536, valueIdentity: "exact",
  decode: bytes => decodeYaml(decodeUtf8Source(bytes)),
  encode: value => encodeUtf8Source(encodeYaml(value)),
});
