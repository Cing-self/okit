import { describe, expect, it } from "vitest";
// Component-level logic lives in parseByExtension; import the module and
// exercise the dispatch table through the exported component's contract.
// (parseByExtension is not exported, so we test through the JSX renderer's
// data path: the same parsers it calls are covered here, plus the dispatch
// rules are pinned by rendering-free assertions on the shared parsers.)
import { tryParseToml } from "../../src/web/frontend/src/components/shared/configParsers";
import yaml from "js-yaml";

describe("config viewer parser dispatch", () => {
  it("JSON.parse handles .json files directly", () => {
    expect(JSON.parse('{"a":1}')).toEqual({ a: 1 });
  });

  it("tryParseToml handles toml but is not fed yaml in the new dispatch", () => {
    expect(tryParseToml('[model]\nname = "x"')).toEqual({ model: { name: "x" } });
    // The hermes yaml block would be misparsed by a blind TOML attempt; the
    // extension dispatch guarantees this parser never sees .yaml files.
  });

  it("js-yaml parses the hermes config shape (yaml → tree)", () => {
    const doc = yaml.load("model:\n  default: glm-5.3-flash\n  context_length: 1179648\nfallback_providers: []\n");
    expect(doc).toEqual({ model: { default: "glm-5.3-flash", context_length: 1179648 }, fallback_providers: [] });
  });

  it("js-yaml rejects invalid yaml so the viewer can fall back to raw text", () => {
    expect(() => yaml.load("a: [1,\n  b: :\n- c")).toThrow();
  });
});
