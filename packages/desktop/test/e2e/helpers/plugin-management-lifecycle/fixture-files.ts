import { join } from "node:path";
import {
  PLUGIN_LIFECYCLE_CONFIG_KEY,
  PLUGIN_LIFECYCLE_EXAMPLE_PROMPT,
  PLUGIN_LIFECYCLE_INHERITED_CONFIG_KEY,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_NAME,
  PLUGIN_LIFECYCLE_NAME,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
} from "./constants.js";
import { writeJson, writeText } from "./json-io.js";

export async function writeLifecyclePlugin(
  pluginRoot: string,
  version: string,
  withUi = false,
): Promise<void> {
  await writeJson(join(pluginRoot, ".zcode-plugin", "plugin.json"), {
    name: PLUGIN_LIFECYCLE_NAME,
    version,
    description: `E2E plugin management lifecycle fixture ${version}`,
    author: { name: "ZCode E2E" },
    homepage: "https://example.com/e2e-plugin-lifecycle",
    commands: "commands",
    agents: "agents",
    skills: "skills",
    hooks: "hooks/hooks.json",
    mcpServers: {
      lifecycle: {
        type: "stdio",
        command: "node",
        args: ["${ZCODE_PLUGIN_ROOT}/server.mjs", version],
      },
    },
    ...(withUi
      ? {
          ui: {
            surfaces: [
              {
                id: "panel",
                title: "Lifecycle Panel",
                server: "lifecycle",
                resourceUri: "ui://lifecycle/panel.html",
                availability: "session",
              },
            ],
          },
        }
      : {}),
    userConfig: {
      [PLUGIN_LIFECYCLE_CONFIG_KEY]: {
        type: "string",
        title: "Lifecycle label",
        default: `fixture-${version}`,
        description: "Non-sensitive E2E lifecycle option",
      },
      [PLUGIN_LIFECYCLE_INHERITED_CONFIG_KEY]: {
        type: "number",
        title: "Timeout seconds",
        default: 30,
        description: "Inherited non-sensitive E2E lifecycle option",
      },
    },
  });
  await writeText(
    join(pluginRoot, "skills", "lifecycle-version", "SKILL.md"),
    [
      "---",
      "name: lifecycle-version",
      `description: ${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_${version}`,
      "---",
      "",
      "# Lifecycle version",
      "",
      `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_${version}`,
    ].join("\n"),
  );
  await writeText(
    join(pluginRoot, "commands", "lifecycle-command.md"),
    `---\ndescription: Lifecycle command ${version}\n---\n\nReport ${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_${version}.\n`,
  );
  await writeText(
    join(pluginRoot, "agents", "lifecycle-reviewer.md"),
    `---\nname: lifecycle-reviewer\ndescription: Lifecycle subagent ${version}\ntools:\n  - Read\n---\nReport ${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_${version}.\n`,
  );
  await writeJson(join(pluginRoot, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{ type: "command", command: "echo E2E_PLUGIN_LIFECYCLE_HOOK" }],
        },
      ],
    },
  });
  await writeText(join(pluginRoot, "server.mjs"), buildDependencyFreeMcpServer(version, withUi));
}

export async function writeSimplePlugin(pluginRoot: string, index: number): Promise<void> {
  await writeJson(join(pluginRoot, ".zcode-plugin", "plugin.json"), {
    name: `e2e-lifecycle-extra-${index}`,
    version: "1.0.0",
    description: `E2E lifecycle category expansion plugin ${index}`,
    skills: "skills",
  });
  await writeText(
    join(pluginRoot, "skills", `extra-${index}`, "SKILL.md"),
    `---\ndescription: E2E extra lifecycle skill ${index}\n---\n\n# Extra ${index}\n`,
  );
}

export async function writeMarketplaceManifest(
  marketplaceRoot: string,
  version: string,
): Promise<void> {
  const extras = Array.from({ length: 7 }, (_, offset) => {
    const index = offset + 1;
    return {
      name: `e2e-lifecycle-extra-${index}`,
      version: "1.0.0",
      description: `E2E lifecycle category expansion plugin ${index}`,
      category: "productivity",
      source: `./plugins/e2e-lifecycle-extra-${index}`,
    };
  });
  await writeJson(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    name: PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    description: PLUGIN_LIFECYCLE_MARKETPLACE_NAME,
    plugins: [
      {
        name: PLUGIN_LIFECYCLE_NAME,
        version,
        displayName: "Lifecycle Fixture",
        displayName_i18n: { "zh-CN": "生命周期测试插件" },
        description: `Deterministic plugin lifecycle fixture ${version}`,
        description_i18n: { "zh-CN": `确定性插件生命周期测试 ${version}` },
        category: "productivity",
        author: { name: "ZCode E2E", url: "https://example.com" },
        homepage: "https://example.com/e2e-plugin-lifecycle",
        privacyPolicy: "https://example.com/privacy",
        termsOfService: "https://example.com/terms",
        examplePrompts: [PLUGIN_LIFECYCLE_EXAMPLE_PROMPT],
        source: `./plugins/${PLUGIN_LIFECYCLE_NAME}`,
      },
      ...extras,
    ],
  });
}

function buildDependencyFreeMcpServer(version: string, withUi = false): string {
  const html =
    '<!doctype html><html><body><h1 id="market-ui-ready">Connecting</h1><script>window.zcode.ready().then(() => { document.getElementById("market-ui-ready").textContent = "PLUGIN_MARKET_UI_READY"; });</script></body></html>';
  return `#!/usr/bin/env node
import readline from "node:readline";
const version = process.argv[2] || ${JSON.stringify(version)};
const input = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {}, ${withUi ? "resources: {}," : ""} }, serverInfo: { name: "e2e-plugin-lifecycle", version } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "version_marker", description: "Return the deterministic lifecycle version marker", inputSchema: { type: "object", properties: {} } }] } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: ${JSON.stringify(PLUGIN_LIFECYCLE_RUNTIME_MARKER)} + "_" + version }] } });
    return;
  }
  ${
    withUi
      ? `if (request.method === "resources/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { resources: [{ uri: "ui://lifecycle/panel.html", name: "Lifecycle Panel", mimeType: "text/html;profile=mcp-app" }] } }); return;
  }
  if (request.method === "resources/read") {
    send({ jsonrpc: "2.0", id: request.id, result: { contents: [{ uri: request.params.uri, mimeType: "text/html;profile=mcp-app", text: ${JSON.stringify(html)} }] } }); return;
  }`
      : ""
  }
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}
