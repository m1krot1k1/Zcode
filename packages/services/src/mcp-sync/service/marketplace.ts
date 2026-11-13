import type {
  ClineMcpMarketplaceCatalog,
  McpRegistryInstallOption,
  McpRegistryMarketplaceEntry,
  McpRegistryMarketplaceResult,
} from "@zcode/shared";
import { parseClineMcpMarketplaceCatalog } from "@zcode/shared";
import { isRecord, readString } from "./utils.js";

const CLINE_MCP_MARKETPLACE_URL = "https://cline.github.io/marketplace/catalog.json";
const CLINE_MCP_MARKETPLACE_TIMEOUT_MS = 8_000;
const CLINE_MCP_MARKETPLACE_MAX_BYTES = 1_000_000;
const OFFICIAL_MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
const OFFICIAL_MCP_REGISTRY_TIMEOUT_MS = 15_000;
const OFFICIAL_MCP_REGISTRY_MAX_BYTES = 2_000_000;
const OFFICIAL_MCP_REGISTRY_MAX_ENTRIES = 20;
const MCP_REGISTRY_SAFE_COMMANDS = new Set(["npx", "uvx", "docker"]);

async function readBoundedMarketplaceBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > CLINE_MCP_MARKETPLACE_MAX_BYTES) {
    throw new Error("Cline MCP marketplace catalog exceeds the response limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Cline MCP marketplace catalog response is empty");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > CLINE_MCP_MARKETPLACE_MAX_BYTES) {
        await reader.cancel();
        throw new Error("Cline MCP marketplace catalog exceeds the response limit");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function loadClineMcpMarketplaceCatalog(
  fetcher: typeof fetch = fetch,
): Promise<ClineMcpMarketplaceCatalog> {
  let response: Response;
  try {
    response = await fetcher(CLINE_MCP_MARKETPLACE_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(CLINE_MCP_MARKETPLACE_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new Error("Cline MCP marketplace catalog is unavailable");
  }
  if (!response.ok) {
    throw new Error("Cline MCP marketplace catalog is unavailable");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new Error("Cline MCP marketplace catalog returned an unsupported content type");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedMarketplaceBody(response)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Cline MCP marketplace catalog is invalid JSON");
    }
    throw error;
  }
  return parseClineMcpMarketplaceCatalog(parsed);
}

async function readBoundedRegistryBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > OFFICIAL_MCP_REGISTRY_MAX_BYTES) {
    throw new Error("Official MCP Registry response exceeds the response limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Official MCP Registry response is empty");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > OFFICIAL_MCP_REGISTRY_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Official MCP Registry response exceeds the response limit");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

export async function searchOfficialMcpRegistry(
  fetcher: typeof fetch,
  query: string,
): Promise<McpRegistryMarketplaceResult> {
  const normalized = query.trim();
  if (normalized.length === 0) return { query: "", entries: [] };
  const url = new URL(OFFICIAL_MCP_REGISTRY_URL);
  url.searchParams.set("search", normalized);
  url.searchParams.set("limit", String(OFFICIAL_MCP_REGISTRY_MAX_ENTRIES));
  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(OFFICIAL_MCP_REGISTRY_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Official MCP Registry is unavailable");
  }
  if (!response.ok) {
    throw new Error(`Official MCP Registry returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new Error("Official MCP Registry returned an unsupported content type");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedRegistryBody(response)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Official MCP Registry returned invalid JSON");
    }
    throw error;
  }
  return parseOfficialMcpRegistryMarketplace(parsed, normalized);
}

function parseOfficialMcpRegistryMarketplace(
  payload: unknown,
  query: string,
): McpRegistryMarketplaceResult {
  if (!isRecord(payload) || !Array.isArray(payload.servers)) {
    throw new Error("Official MCP Registry returned an invalid response");
  }
  const entries: McpRegistryMarketplaceEntry[] = [];
  const seen = new Set<string>();
  for (const raw of payload.servers) {
    if (entries.length >= OFFICIAL_MCP_REGISTRY_MAX_ENTRIES) break;
    if (!isRecord(raw) || !isRecord(raw.server)) continue;
    const server = raw.server;
    const id = readString(server.name);
    if (!id || id.length > 200 || seen.has(id)) continue;
    const options = [
      ...parseRegistryPackages(server.packages),
      ...parseRegistryRemotes(server.remotes),
    ];
    if (options.length === 0) continue;
    seen.add(id);
    const description = readString(server.description);
    const version = readString(server.version);
    const repository = isRecord(server.repository) ? readString(server.repository.url) : undefined;
    entries.push({
      id,
      name: id,
      ...(description ? { description } : {}),
      ...(version ? { version } : {}),
      ...(repository ? { repositoryUrl: repository } : {}),
      options,
    });
  }
  return { query, entries };
}

function parseRegistryPackages(raw: unknown): McpRegistryInstallOption[] {
  if (!Array.isArray(raw)) return [];
  const options: McpRegistryInstallOption[] = [];
  for (const pkg of raw) {
    if (!isRecord(pkg) || pkg.registryType !== "npm") continue;
    const identifier = readString(pkg.identifier);
    if (!identifier) continue;
    const transport = isRecord(pkg.transport) ? readString(pkg.transport.type) : undefined;
    if (transport && transport !== "stdio") continue;
    const runtimeHint = (readString(pkg.runtimeHint) ?? "npx").toLowerCase();
    if (!MCP_REGISTRY_SAFE_COMMANDS.has(runtimeHint)) continue;
    const version = readString(pkg.version);
    const packageSpec = version ? `${identifier}@${version}` : identifier;
    const runtimeArgs = Array.isArray(pkg.runtimeArguments)
      ? pkg.runtimeArguments.flatMap((argument) =>
          isRecord(argument) && typeof argument.value === "string" ? [argument.value] : [],
        )
      : [];
    const args =
      runtimeHint === "docker" ? ["run", "-i", "--rm", packageSpec] : [...runtimeArgs, packageSpec];
    const requiredEnv = parseRegistryEnv(pkg.environmentVariables);
    const env: Record<string, string> = {};
    for (const item of requiredEnv) {
      if (item.default !== undefined) env[item.name] = item.default;
    }
    options.push({
      kind: "stdio",
      command: runtimeHint,
      args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(requiredEnv.length > 0 ? { requiredEnv } : {}),
      requiresAuth: requiredEnv.some((item) => item.isSecret === true || item.required === true),
    });
  }
  return options;
}

function parseRegistryRemotes(raw: unknown): McpRegistryInstallOption[] {
  if (!Array.isArray(raw)) return [];
  const options: McpRegistryInstallOption[] = [];
  for (const remote of raw) {
    if (!isRecord(remote)) continue;
    const url = readString(remote.url);
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") continue;
    const remoteType = (readString(remote.type) ?? "streamable-http").toLowerCase();
    if (remoteType !== "streamable-http" && remoteType !== "sse" && remoteType !== "http") continue;
    const requiredHeaders = parseRegistryHeaders(remote.headers);
    options.push({
      kind: "remote",
      url,
      transport: remoteType === "sse" ? "sse" : "http",
      ...(requiredHeaders.length > 0 ? { requiredHeaders } : {}),
      requiresAuth: requiredHeaders.some(
        (item) => item.isSecret === true || item.required === true,
      ),
    });
  }
  return options;
}

function parseRegistryEnv(raw: unknown): NonNullable<McpRegistryInstallOption["requiredEnv"]> {
  if (!Array.isArray(raw)) return [];
  const result: NonNullable<McpRegistryInstallOption["requiredEnv"]> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = readString(item.name);
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
    const description = readString(item.description);
    result.push({
      name,
      ...(description ? { description } : {}),
      ...(item.isSecret === true ? { isSecret: true } : {}),
      ...(item.isRequired === true ? { required: true } : {}),
      ...(typeof item.default === "string" ? { default: item.default } : {}),
    });
  }
  return result;
}

function parseRegistryHeaders(
  raw: unknown,
): NonNullable<McpRegistryInstallOption["requiredHeaders"]> {
  if (!Array.isArray(raw)) return [];
  const result: NonNullable<McpRegistryInstallOption["requiredHeaders"]> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = readString(item.name);
    if (!name || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)) continue;
    const description = readString(item.description);
    result.push({
      name,
      ...(description ? { description } : {}),
      ...(item.isSecret === true ? { isSecret: true } : {}),
      ...(item.isRequired === true ? { required: true } : {}),
    });
  }
  return result;
}
