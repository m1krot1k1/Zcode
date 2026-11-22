import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseZCodeBuiltinModelConfigRules } from "@zcode/provider";

describe("local OpenAI-compatible coding template", () => {
  it.each(["zcode-builtin.json", "zcode-builtin.test.json"])(
    "%s exposes the Qwen pi-adapted local preset",
    async (filename) => {
      const release = JSON.parse(
        await readFile(new URL(`../../../config/provider/${filename}`, import.meta.url), "utf8"),
      );
      const templates = release.config.providerConfigRules.templateRules as Array<{
        templateId: string;
        templateNameMap: Record<string, string>;
        config: {
          access: { type: string; apiKeyManagementUrl?: string };
          api: { type: string; baseUrl: string };
          builtinModelIds: string[];
        };
      }>;
      const template = templates.find((item) => item.templateId === "local-openai-compatible");
      expect(template).toBeDefined();
      expect(template?.templateNameMap).toMatchObject({
        "en-US": "Local OpenAI-compatible",
      });
      expect(template?.config.api).toEqual({
        type: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:8000/v1",
      });
      expect(template?.config.builtinModelIds).toEqual(["qwen3.8-pi"]);
      expect(template?.config.access.type).toBe("api-key");
      expect(template?.config.access.apiKeyManagementUrl).toMatch(/^https:\/\//u);

      const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
      const resolved = rules.resolve({
        templateId: "local-openai-compatible",
        providerId: "local-qwen",
        modelId: "qwen3.8-pi",
        apiType: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:8000/v1",
      });
      expect(resolved.enabled).toBe(true);
    },
  );
});
