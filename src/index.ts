import type { PlaneMember } from "./modules/plane/domain/entities/member";
import type {
  ApiProvider,
  GitLabProvider,
  PachkaProvider,
  PlaneProvider,
  TaigaProvider,
} from "./core/config";
import { PlaneClient } from "./modules/plane/infrastructure/clients/plane-api-client";
import { TaigaApiClient } from "./modules/taiga/infrastructure/clients/taiga-api-client";
import { GitLabApiClient } from "./modules/gitlab/infrastructure/clients/gitlab-api-client";
import { PachkaClient } from "./modules/messenger/infrastructure/clients/pachka-api-client";
import { MessageStore } from "./modules/messenger/infrastructure/persistence/sqlite-message-store";
import { PipelineStateStore } from "./core/persistence/sqlite-pipeline-state";
import { ProviderRegistry } from "./core/provider-registry";
import { createApp } from "./app";
import { loadConfig, validateConfig } from "./core/config";
import { loadDotEnv } from "./core/env";
import { log } from "./core/logger";

// Load config & env. .env first and with precedence over the inherited environment: a variable
// exported by the shell (or set machine-wide) must not quietly replace the project's credentials.
await loadDotEnv();

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
    throw new Error(
      `No API key for plane provider "${p.alias}": set ${envName} or PLANE_API_KEY`,
    );
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
  const applicationToken =
    process.env[`TAIGA_APP_TOKEN_${suffix}`] ?? process.env.TAIGA_APP_TOKEN;
  const username =
    process.env[`TAIGA_USERNAME_${suffix}`] ?? process.env.TAIGA_USERNAME;
  const password =
    process.env[`TAIGA_PASSWORD_${suffix}`] ?? process.env.TAIGA_PASSWORD;
  if (!applicationToken && !(username && password)) {
    throw new Error(
      `No credentials for taiga provider "${p.alias}": set TAIGA_APP_TOKEN_${suffix} or TAIGA_USERNAME_${suffix} + TAIGA_PASSWORD_${suffix}`,
    );
  }
  const client = new TaigaApiClient(p.baseUrl, {
    applicationToken,
    username,
    password,
  });
  await client.login();
  taigaClients.set(`taiga:${p.alias}`, client);
  log.info(`Taiga client initialized for "${p.alias}"`, {
    baseUrl: p.baseUrl,
    project: p.project,
  });
}

// Build one GitLab client per provider. Token resolution mirrors plane's scheme:
// GITLAB_TOKEN_<ALIAS> (alias upper-cased, non-alphanumerics -> "_"), falling back to GITLAB_TOKEN.
// An admin token can resolve people by their private email; otherwise map them in `userMap`.
const gitlabProviders = registry.getByType("gitlab") as GitLabProvider[];
const gitlabClients = new Map<string, GitLabApiClient>();
// Secret tokens of the incoming GitLab webhooks (X-Gitlab-Token), same per-alias scheme.
const gitlabWebhookSecrets: string[] = [];
for (const p of gitlabProviders) {
  const suffix = p.alias.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const envName = `GITLAB_TOKEN_${suffix}`;
  const token = process.env[envName] ?? process.env.GITLAB_TOKEN;
  if (!token) {
    throw new Error(
      `No API token for gitlab provider "${p.alias}": set ${envName} or GITLAB_TOKEN`,
    );
  }
  const client = new GitLabApiClient(p.baseUrl, token);
  gitlabClients.set(`gitlab:${p.alias}`, client);

  const hookSecret =
    process.env[`GITLAB_WEBHOOK_SECRET_${suffix}`] ??
    process.env.GITLAB_WEBHOOK_SECRET;
  if (hookSecret && !gitlabWebhookSecrets.includes(hookSecret))
    gitlabWebhookSecrets.push(hookSecret);

  try {
    const me = await client.getCurrentUser();
    log.info(`GitLab client initialized for "${p.alias}"`, {
      baseUrl: p.baseUrl,
      project: p.project,
      actingAs: me.username,
    });
  } catch (e) {
    // A group- or project-scoped token may not read /user at all; the token still works for the
    // repository calls, so this is a warning and not a startup failure.
    log.warn(
      `GitLab client for "${p.alias}": could not read the token identity (GET /user)`,
      {
        baseUrl: p.baseUrl,
        error: String(e),
      },
    );
  }
}

// Durable pipeline state: `once` guards and the branch/MR -> tracker item links a GitLab
// webhook needs to find its task again. Cheap, and needed by every trigger kind.
const pipelineState = new PipelineStateStore();

if (gitlabProviders.length > 0 && gitlabWebhookSecrets.length === 0) {
  log.warn(
    "No GITLAB_WEBHOOK_SECRET set: POST /webhook/gitlab accepts unverified payloads. " +
      "Set the same secret token on the webhook in GitLab and in the env",
  );
}

// Resolve intake API keys per api provider, same scheme as plane/taiga:
// INTAKE_API_KEY_<ALIAS> falling back to INTAKE_API_KEY. A provider may opt out with "auth": false.
const intakeApiKeys = new Map<string, string>();
for (const p of registry.getByType("api") as ApiProvider[]) {
  if (p.auth === false) {
    log.warn(
      `Intake endpoint "${p.endpoint}" (api:${p.alias}) is public: "auth": false set in config`,
    );
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
  log.info(
    "PACHKA_API_TOKEN not set — API features disabled, webhook-only mode",
  );
}

// Forms require the Pachka API (POST /views/open needs a bot token with the views:write scope).
if (registry.getByType("form").length > 0 && !pachkaClient) {
  log.warn(
    "Form providers configured but PACHKA_API_TOKEN is not set — forms will not open",
  );
}

// DMs resolve the recipient through GET /users (users:read scope), so they need the API too.
if (
  (registry.getByType("pachka") as PachkaProvider[]).some((p) => p.dm) &&
  !pachkaClient
) {
  log.warn(
    "DM providers configured but PACHKA_API_TOKEN is not set — direct messages will be skipped",
  );
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
    log.info(
      `Loaded ${projects.length} projects from workspace "${p.workspace}"`,
    );
  } catch (e) {
    log.error(`Failed to load projects for workspace "${p.workspace}"`, {
      error: String(e),
    });
  }

  try {
    const members = await client.getMembers(p.workspace);
    for (const m of members) memberMap.set(m.id, m);
    log.info(
      `Loaded ${members.length} members from workspace "${p.workspace}"`,
    );
  } catch (e) {
    log.error(`Failed to load members for workspace "${p.workspace}"`, {
      error: String(e),
    });
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
  gitlabWebhookSecrets,
  planeClients,
  taigaClients,
  gitlabClients,
  intakeApiKeys,
  pipelineState,
}).listen(port);

log.info(`DevFlow Bridge listening on :${port}`);
log.info(
  `Providers: ${config.providers.length}, Pipelines: ${config.rules.length}`,
);
