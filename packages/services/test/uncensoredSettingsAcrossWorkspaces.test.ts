import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createUncensoredSettingsStore,
  UNCENSORED_SETTINGS_FILE,
  type UncensoredCredentialStore,
} from "../src/code-intelligence/uncensoredSettings.js";

function workspace(path: string) {
  return { workspacePath: path, workspaceIdentity: path };
}

/**
 * The provider list is user-level: the mirrored provider appears in the registry for every
 * workspace, so takeover must see the same configuration everywhere. Before this, a workspace
 * without its own settings entry reported `no-enabled-models` while the provider was visible
 * and usable in the composer.
 */
describe("uncensored takeover config across workspaces", () => {
  it("reuses settings saved under another workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-uncensored-"));
    const foreignKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(
      join(root, UNCENSORED_SETTINGS_FILE),
      JSON.stringify({
        [`uncensored:${foreignKey}:providers`]: JSON.stringify([
          {
            id: "provider-1",
            name: "nano-gpt",
            apiUrl: "https://api.nano-gpt.com/api/v1",
            apiKeyConfigured: true,
            models: [{ id: "deepseek-uncensored", enabled: true }],
          },
        ]),
      }),
    );
    const credentialStore: UncensoredCredentialStore = {
      load: vi.fn(async (key: string) =>
        key === `code-intelligence:${foreignKey}:uncensored-api-key:provider-1` ? "secret" : null,
      ),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const store = createUncensoredSettingsStore({
      indexRootDir: root,
      credentialStore,
    });

    const config = await store.readTakeoverConfig(workspace("/home/user/another-repo"));

    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]).toMatchObject({
      id: "provider-1",
      name: "nano-gpt",
      apiKey: "secret",
      models: [{ id: "deepseek-uncensored", enabled: true }],
    });
  });

  it("prefers the workspace's own settings when it has them", async () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-uncensored-"));
    const ownWorkspace = workspace("/home/user/repo");
    const store = createUncensoredSettingsStore({ indexRootDir: root });
    await store.write(ownWorkspace, {
      providers: [
        {
          id: "provider-own",
          name: "own",
          apiUrl: "https://own.test/v1",
          models: [{ id: "m", enabled: true }],
        },
      ],
    });

    const config = await store.readTakeoverConfig(ownWorkspace);

    expect(config.providers.map((provider) => provider.id)).toEqual(["provider-own"]);
  });
});
