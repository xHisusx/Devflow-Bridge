import type { PlaneMember } from "./modules/plane/domain/entities/member";
import type { ApiProvider, PlaneProvider, TaigaProvider, BitrixProvider } from "./core/config";
import { PlaneClient } from "./modules/plane/infrastructure/clients/plane-api-client";
import { TaigaApiClient } from "./modules/taiga/infrastructure/clients/taiga-api-client";
import { PachkaClient } from "./modules/messenger/infrastructure/clients/pachka-api-client";
import { MessageStore } from "./modules/messenger/infrastructure/persistence/sqlite-message-store";
import { ProviderRegistry } from "./core/provider-registry";
import { createApp } from "./app";
import { loadConfig, validateConfig } from "./core/config";
import { log } from "./core/logger";
import { BitrixApiClient } from "./modules/bitrix/infrastructure/clients/bitrix-api-client";

// Load config & env
const config = await loadConfig();
const registry = new ProviderRegistry(config.providers);

const PLANE_API_KEY = process.env.PLANE_API_KEY;
const PLANE_WEBHOOK_SECRET = process.env.PLANE_WEBHOOK_SECRET;
const TAIGA_WEBHOOK_SECRET = process.env.TAIGA_WEBHOOK_SECRET;
const PACHKA_API_TOKEN = process.env.PACHKA_API_TOKEN;

const planeProviders = registry.getByType("plane") as PlaneProvider[];
if (planeProviders.length === 0 && registry.getByType("taiga").length === 0) {
  throw new Error("No tracker provider configured (plane or taiga)");
}

// Build one Plane client per provider (own baseUrl + API key). Key resolution:
// PLANE_API_KEY_<ALIAS> (alias upper-cased, non-alphanumerics -> "_"), falling back to PLANE_API_KEY.
const planeClients = new Map<string, PlaneClient>();
for (const p of planeProviders) {
  const envName = `PLANE_API_KEY_${p.alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const apiKey = process.env[envName] ?? PLANE_API_KEY;
  if (!apiKey) {
    throw new Error(`No API key for plane provider "${p.alias}": set ${envName} or PLANE_API_KEY`);
  }
  planeClients.set(`plane:${p.alias}`, new PlaneClient(p.baseUrl, apiKey));
}

// Build one Taiga client per provider. Credential resolution mirrors plane's scheme:
// TAIGA_APP_TOKEN_<ALIAS> or TAIGA_USERNAME_<ALIAS>/TAIGA_PASSWORD_<ALIAS>
// (alias upper-cased, non-alphanumerics -> "_"), falling back to the unsuffixed variants.
const taigaProviders = registry.getByType("taiga") as TaigaProvider[];
const taigaClients = new Map<string, TaigaApiClient>();
for (const p of taigaProviders) {
  const suffix = p.alias.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const applicationToken = process.env[`TAIGA_APP_TOKEN_${suffix}`] ?? process.env.TAIGA_APP_TOKEN;
  const username = process.env[`TAIGA_USERNAME_${suffix}`] ?? process.env.TAIGA_USERNAME;
  const password = process.env[`TAIGA_PASSWORD_${suffix}`] ?? process.env.TAIGA_PASSWORD;
  if (!applicationToken && !(username && password)) {
    throw new Error(
      `No credentials for taiga provider "${p.alias}": set TAIGA_APP_TOKEN_${suffix} or TAIGA_USERNAME_${suffix} + TAIGA_PASSWORD_${suffix}`,
    );
  }
  const client = new TaigaApiClient(p.baseUrl, { applicationToken, username, password });
  await client.login();
  taigaClients.set(`taiga:${p.alias}`, client);
  log.info(`Taiga client initialized for "${p.alias}"`, { baseUrl: p.baseUrl, project: p.project });
}

const bitrixProviders = registry.getByType("bitrix") as BitrixProvider[];
const bitrixClients = new Map<string, BitrixApiClient>();
for (const p of bitrixProviders) {
  const suffix = p.alias.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const token = process.env[`BITRIX_API_TOKEN_${suffix}`] ?? process.env.BITRIX_API_TOKEN;
  if (!token) {
    throw new Error(`No token for bitrix provider "${p.alias}": set BITRIX_API_TOKEN_${suffix} or BITRIX_API_TOKEN`);
  }
  bitrixClients.set(`bitrix:${p.alias}`, new BitrixApiClient(token, p.baseUrl));
  log.info(`Bitrix client initialized for "${p.alias}"`, { baseUrl: p.baseUrl });
}

// Resolve intake API keys per api provider, same scheme as plane/taiga:
// INTAKE_API_KEY_<ALIAS> falling back to INTAKE_API_KEY. A provider may opt out with "auth": false.
const intakeApiKeys = new Map<string, string>();
for (const p of registry.getByType("api") as ApiProvider[]) {
  if (p.auth === false) {
    log.warn(`Intake endpoint "${p.endpoint}" (api:${p.alias}) is public: "auth": false set in config`);
    continue;
  }
  const envName = `INTAKE_API_KEY_${p.alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const apiKey = process.env[envName] ?? process.env.INTAKE_API_KEY;
  if (!apiKey) {
    throw new Error(
      `No API key for api provider "${p.alias}": set ${envName} or INTAKE_API_KEY (or "auth": false on the provider to disable auth)`,
    );
  }
  intakeApiKeys.set(`api:${p.alias}`, apiKey);
}

// Initialize Pachka API client (optional)
let pachkaClient: PachkaClient | null = null;
let messageStore: MessageStore | null = null;

if (PACHKA_API_TOKEN) {
  pachkaClient = new PachkaClient(PACHKA_API_TOKEN);
  messageStore = new MessageStore();
  void pachkaClient.warmup();
  log.info("Pachka API client initialized");
} else {
  log.info("PACHKA_API_TOKEN not set — API features disabled, webhook-only mode");
}

// Forms require the Pachka API (POST /views/open needs a bot token with the views:write scope).
if (registry.getByType("form").length > 0 && !pachkaClient) {
  log.warn("Form providers configured but PACHKA_API_TOKEN is not set — forms will not open");
}

// Resolve project names -> IDs and workspace members on startup, per plane provider
// (each provider uses its own client, so different Plane instances are supported).
const projectIdMap = new Map<string, string>();
const projectIdentifierMap = new Map<string, string>();
const memberMap = new Map<string, PlaneMember>();

const seenWorkspaces = new Set<string>();
for (const p of planeProviders) {
  const client = planeClients.get(`plane:${p.alias}`)!;
  const wsKey = `${p.baseUrl}::${p.workspace}`;
  if (seenWorkspaces.has(wsKey)) continue; // same instance+workspace already loaded
  seenWorkspaces.add(wsKey);

  try {
    const projects = await client.getProjects(p.workspace);
    for (const proj of projects) {
      projectIdMap.set(`${p.workspace}:${proj.name}`, proj.id);
      projectIdMap.set(`${p.workspace}:${proj.identifier}`, proj.id);
      projectIdentifierMap.set(proj.id, proj.identifier);
    }
    log.info(`Loaded ${projects.length} projects from workspace "${p.workspace}"`);
  } catch (e) {
    log.error(`Failed to load projects for workspace "${p.workspace}"`, { error: String(e) });
  }

  try {
    const members = await client.getMembers(p.workspace);
    for (const m of members) memberMap.set(m.id, m);
    log.info(`Loaded ${members.length} members from workspace "${p.workspace}"`);
  } catch (e) {
    log.error(`Failed to load members for workspace "${p.workspace}"`, { error: String(e) });
  }
}

// Validate config
validateConfig(config, registry, log);

const port = Number(process.env.PORT) || 3000;

createApp({
  config,
  registry,
  pachkaClient,
  messageStore,
  projectIdMap,
  projectIdentifierMap,
  memberMap,
  webhookSecret: PLANE_WEBHOOK_SECRET,
  taigaWebhookSecret: TAIGA_WEBHOOK_SECRET,
  planeClients,
  taigaClients,
  bitrixClients,
  intakeApiKeys,
}).listen(port);

log.info(`DevFlow Bridge listening on :${port}`);
log.info(`Providers: ${config.providers.length}, Pipelines: ${config.rules.length}`);
