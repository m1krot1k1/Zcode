interface OpenCodeCliReleaseAsset {
  fileName: string;
  archive: "zip" | "tar.gz";
  executableName: "opencode" | "opencode.exe";
  sha256: string;
}

export const OPEN_CODE_CLI_RELEASE_VERSION = "1.19.3";

const ASSETS: Readonly<Record<string, OpenCodeCliReleaseAsset>> = {
  "darwin-arm64": {
    fileName: "opencode-darwin-arm64.zip",
    archive: "zip",
    executableName: "opencode",
    sha256: "c2d0fecd27acf6e08be02c1f5d384614d07495587766bcc4a6bff3971749bb64",
  },
  "darwin-x64": {
    fileName: "opencode-darwin-x64-baseline.zip",
    archive: "zip",
    executableName: "opencode",
    sha256: "03f8c32f81a2c35429afedfb8f63978af32329febcebf800d52486f6ba568151",
  },
  "win32-arm64": {
    fileName: "opencode-windows-arm64.zip",
    archive: "zip",
    executableName: "opencode.exe",
    sha256: "c1b9daf18c97564b2d171703279621f7edc3613e70750d796ef78db87257ad89",
  },
  "win32-x64": {
    fileName: "opencode-windows-x64-baseline.zip",
    archive: "zip",
    executableName: "opencode.exe",
    sha256: "0d59113484bfe8d6dc146fc981f5c33faa8318303c183711b7a9387060b289e8",
  },
  "linux-arm64-glibc": {
    fileName: "opencode-linux-arm64.tar.gz",
    archive: "tar.gz",
    executableName: "opencode",
    sha256: "7900818a6a98881edbbadab4b7525940eff3b9750040c200481f9f56cacee405",
  },
  "linux-arm64-musl": {
    fileName: "opencode-linux-arm64-musl.tar.gz",
    archive: "tar.gz",
    executableName: "opencode",
    sha256: "39c9ff1ea47fd59752613079f97bef40a2d14c30bc6bb5772a91d9d708e2d0b3",
  },
  "linux-x64-glibc": {
    fileName: "opencode-linux-x64-baseline.tar.gz",
    archive: "tar.gz",
    executableName: "opencode",
    sha256: "531cff2441129c30f0edd5878af494108ad07f5feb46d7ee29a2a5b830a5765d",
  },
  "linux-x64-musl": {
    fileName: "opencode-linux-x64-baseline-musl.tar.gz",
    archive: "tar.gz",
    executableName: "opencode",
    sha256: "738506562666cc67e3512f04ecac50c0bae833c5bf44e1a59c99e5827a851778",
  },
};

export function resolveOpenCodeCliReleaseAsset(input: {
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  linuxLibc?: "glibc" | "musl";
}): OpenCodeCliReleaseAsset | undefined {
  const key =
    input.platform === "linux"
      ? `linux-${input.architecture}-${input.linuxLibc ?? "glibc"}`
      : `${input.platform}-${input.architecture}`;
  return ASSETS[key];
}

export function getOpenCodeCliReleaseAssets(): ReadonlyArray<{
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  linuxLibc?: "glibc" | "musl";
  asset: OpenCodeCliReleaseAsset;
}> {
  return Object.entries(ASSETS).map(([key, asset]) => {
    const [platform, architecture, linuxLibc] = key.split("-");
    return {
      platform: platform as NodeJS.Platform,
      architecture: architecture as NodeJS.Architecture,
      ...(linuxLibc === "glibc" || linuxLibc === "musl" ? { linuxLibc } : {}),
      asset,
    };
  });
}
