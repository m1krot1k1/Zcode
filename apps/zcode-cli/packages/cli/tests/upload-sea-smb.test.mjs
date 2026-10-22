import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_DESTINATION_ROOT,
  DEFAULT_SMB_URL,
  collectSeaUploadFiles,
  ensureDestinationRoot,
  parseUploadSeaSmbArgs,
  readRootPackageVersion,
  resolveDefaultDestinationRoot,
  releaseDirectoryName,
  seaUploadBinaryNames,
  uploadSeaBinaries,
} from "../scripts/upload-sea-smb.mjs";

const createReleaseFixture = async (root) => {
  const distDir = join(root, "dist");
  const rootDirectory = join(root, "repo");
  const destinationRoot = join(root, "shared", "zcode", "deps");

  await mkdir(distDir, {
    recursive: true,
  });
  await mkdir(rootDirectory, {
    recursive: true,
  });
  await writeFile(join(rootDirectory, "package.json"), JSON.stringify({ version: "1.2.3" }));

  for (const fileName of seaUploadBinaryNames()) {
    await writeFile(join(distDir, fileName), `binary:${fileName}`);
  }

  return {
    destinationRoot,
    distDir,
    rootDirectory,
  };
};

test("parses upload arguments with defaults and overrides", () => {
  assert.deepEqual(parseUploadSeaSmbArgs([]), {
    destinationRoot: DEFAULT_DESTINATION_ROOT,
    distDir: resolve(import.meta.dirname, "../dist"),
    force: false,
    help: false,
    smbUrl: DEFAULT_SMB_URL,
    version: undefined,
  });

  const cwd = "/tmp/zcode-upload";
  assert.deepEqual(
    parseUploadSeaSmbArgs(
      [
        "--force",
        "--dist",
        "dist-out",
        "--dest-root=/mnt/shared/zcode/deps",
        "--version",
        "9.8.7",
        "--smb-url",
        "smb://example/shared",
      ],
      {
        cwd,
      },
    ),
    {
      destinationRoot: "/mnt/shared/zcode/deps",
      distDir: "/tmp/zcode-upload/dist-out",
      force: true,
      help: false,
      smbUrl: "smb://example/shared",
      version: "9.8.7",
    },
  );

  assert.throws(() => parseUploadSeaSmbArgs(["--unknown"]), /Unknown option/);
});

test("uses INTRANET_MACHINE_HOST for the default SMB URL", () => {
  assert.equal(
    parseUploadSeaSmbArgs([], {
      env: {
        INTRANET_MACHINE_HOST: "192.0.2.10",
      },
    }).smbUrl,
    "smb://192.0.2.10/shared",
  );
});

test("resolves a portable SMB destination without applying the macOS mount on other systems", () => {
  assert.equal(resolveDefaultDestinationRoot({ platform: "darwin", env: {} }), DEFAULT_DESTINATION_ROOT);
  assert.equal(resolveDefaultDestinationRoot({ platform: "linux", env: {} }), undefined);
  assert.equal(resolveDefaultDestinationRoot({ platform: "win32", env: {} }), undefined);
  assert.equal(
    resolveDefaultDestinationRoot({ platform: "win32", env: { ZCODE_SEA_DEST_ROOT: "Z:\\shared\\zcode\\deps" } }),
    "Z:\\shared\\zcode\\deps",
  );

  assert.equal(
    parseUploadSeaSmbArgs([], { cwd: "/repo", platform: "linux", env: { ZCODE_SEA_DEST_ROOT: "mnt/shared/zcode/deps" } })
      .destinationRoot,
    "/repo/mnt/shared/zcode/deps",
  );
  assert.equal(
    parseUploadSeaSmbArgs(["--dest-root", "/explicit/share"], {
      cwd: "/repo",
      platform: "linux",
      env: { ZCODE_SEA_DEST_ROOT: "/environment/share" },
    }).destinationRoot,
    "/explicit/share",
  );
});

test("fails closed when another OS has no configured SMB destination", async () => {
  await assert.rejects(
    ensureDestinationRoot({ destinationRoot: undefined, smbUrl: "smb://example/shared" }),
    /No SMB destination configured.*ZCODE_SEA_DEST_ROOT.*--dest-root/,
  );
});

test("does not interpret an explicit POSIX target as a macOS SMB mount on Linux", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-upload-explicit-linux-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const destinationRoot = join(directory, "Volumes", "shared", "zcode", "deps");

  await ensureDestinationRoot({
    destinationRoot,
    smbUrl: "smb://example/shared",
    platform: "linux",
  });

  assert.equal((await stat(destinationRoot)).isDirectory(), true);
});

test("reads root package version and rejects path-like release versions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-upload-version-"));
  t.after(() =>
    rm(directory, {
      force: true,
      recursive: true,
    }),
  );
  await writeFile(join(directory, "package.json"), JSON.stringify({ version: "2.0.1" }));

  assert.equal(await readRootPackageVersion({ rootDirectory: directory }), "2.0.1");
  assert.equal(releaseDirectoryName("2.0.1"), "zcode-cli-2.0.1");
  assert.throws(() => releaseDirectoryName("../2.0.1"), /Invalid release version/);
  assert.throws(() => releaseDirectoryName(".."), /Invalid release version/);
});

test("collects all SEA upload binaries and reports missing files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-upload-files-"));
  t.after(() =>
    rm(directory, {
      force: true,
      recursive: true,
    }),
  );

  for (const fileName of seaUploadBinaryNames()) {
    await writeFile(join(directory, fileName), fileName);
  }

  const files = await collectSeaUploadFiles({
    distDir: directory,
  });
  assert.deepEqual(
    files.map((file) => file.fileName),
    [
      "zcode-darwin-arm64",
      "zcode-darwin-x64",
      "zcode-linux-arm64",
      "zcode-linux-x64",
      "zcode-windows-arm64.exe",
      "zcode-windows-x64.exe",
    ],
  );

  await rm(join(directory, "zcode-linux-x64"));
  await assert.rejects(
    () =>
      collectSeaUploadFiles({
        distDir: directory,
      }),
    /Missing SEA binaries/,
  );
});

test("uploads release binaries into a versioned destination with progress events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-upload-release-"));
  t.after(() =>
    rm(directory, {
      force: true,
      recursive: true,
    }),
  );
  const fixture = await createReleaseFixture(directory);
  const events = [];

  const result = await uploadSeaBinaries({
    ...fixture,
    force: false,
    onProgress: (event) => events.push(event),
    smbUrl: "smb://example/shared",
  });

  assert.equal(result.status, "uploaded");
  assert.equal(result.version, "1.2.3");
  assert.equal(result.destination, join(fixture.destinationRoot, "zcode-cli-1.2.3"));
  assert.equal(events[0]?.type, "start");
  assert.equal(events.at(-1)?.type, "complete");
  assert.equal(
    events.some((event) => event.type === "progress"),
    true,
  );

  for (const fileName of seaUploadBinaryNames()) {
    assert.equal(await readFile(join(result.destination, fileName), "utf8"), `binary:${fileName}`);
  }
});

test("abandons an existing release when the user chooses abandon", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-upload-abandon-"));
  t.after(() =>
    rm(directory, {
      force: true,
      recursive: true,
    }),
  );
  const fixture = await createReleaseFixture(directory);
  const destination = join(fixture.destinationRoot, "zcode-cli-1.2.3");
  const events = [];

  await mkdir(destination, {
    recursive: true,
  });
  await writeFile(join(destination, "keep.txt"), "keep");

  const result = await uploadSeaBinaries({
    ...fixture,
    confirmExistingVersion: async () => "abandon",
    force: false,
    onProgress: (event) => events.push(event),
    smbUrl: "smb://example/shared",
  });

  assert.equal(result.status, "abandoned");
  assert.equal(events.length, 0);
  assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "keep");
});

test("force replaces an existing release directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-upload-force-"));
  t.after(() =>
    rm(directory, {
      force: true,
      recursive: true,
    }),
  );
  const fixture = await createReleaseFixture(directory);
  const destination = join(fixture.destinationRoot, "zcode-cli-1.2.3");

  await mkdir(destination, {
    recursive: true,
  });
  await writeFile(join(destination, "stale.txt"), "stale");

  const result = await uploadSeaBinaries({
    ...fixture,
    force: true,
    smbUrl: "smb://example/shared",
  });

  assert.equal(result.status, "uploaded");
  await assert.rejects(() => stat(join(destination, "stale.txt")), /ENOENT/);
  assert.equal(
    await readFile(join(destination, "zcode-darwin-arm64"), "utf8"),
    "binary:zcode-darwin-arm64",
  );
});
