import { Elysia } from "elysia";
import type { Config, ApiProvider } from "./core/config";
import type { ProviderRegistry } from "./core/provider-registry";
import type { PlaneMember } from "./modules/plane/domain/entities/member";
import type { IMessengerClient } from "./modules/messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "./modules/messenger/application/ports/message-store.port";
import { EventBus } from "./core/events";
import { ProcessPlaneWebhookUseCase } from "./modules/plane/application/use-cases/process-plane-webhook";
import { planeWebhookRoute } from "./modules/plane/infrastructure/webhooks/plane-webhook.route";
import { pachkaCallbackRoute } from "./modules/messenger/infrastructure/webhooks/pachka-callback.route";
import { intakeIssueRoute } from "./modules/plane/infrastructure/routes/intake-issue.route";
import { ProcessIntakePipelineUseCase } from "./modules/plane/application/use-cases/process-intake-pipeline";
import { HandleTaigaFeedbackUseCase } from "./modules/taiga/application/use-cases/handle-taiga-feedback";
import { OpenFormViewUseCase } from "./modules/messenger/application/use-cases/open-form-view";
import { ProcessFormSubmissionUseCase } from "./modules/messenger/application/use-cases/process-form-submission";
import { ProcessTaigaWebhookUseCase } from "./modules/taiga/application/use-cases/process-taiga-webhook";
import { ProcessTaigaTriggerUseCase } from "./modules/taiga/application/use-cases/process-taiga-trigger";
import { taigaWebhookRoute } from "./modules/taiga/infrastructure/webhooks/taiga-webhook.route";
import { ProcessGitLabTriggerUseCase } from "./modules/gitlab/application/use-cases/process-gitlab-trigger";
import { gitlabWebhookRoute } from "./modules/gitlab/infrastructure/webhooks/gitlab-webhook.route";
import { PachkaUserDirectory } from "./modules/messenger/application/services/pachka-user-directory";
import type { IPlaneApiClient } from "./modules/plane/application/ports/plane-api.port";
import type { ITaigaApiClient } from "./modules/taiga/application/ports/taiga-api.port";
import type { IGitLabApiClient } from "./modules/gitlab/application/ports/gitlab-api.port";
import type { IBitrixClient } from "./modules/bitrix/application/ports/bitrix-api.port";
import type { IPipelineStateStore } from "./core/persistence/pipeline-state.port";
import { parseRef } from "./modules/messenger/domain/entities/notification";
import { log } from "./core/logger";

export interface AppDependencies {
  config: Config;
  registry: ProviderRegistry;
  pachkaClient: IMessengerClient | null;
  messageStore: IMessageStore | null;
  projectIdMap: Map<string, string>;
  projectIdentifierMap: Map<string, string>;
  memberMap: Map<string, PlaneMember>;
  webhookSecret?: string;
  /** Secret configured on the Taiga webhook (X-TAIGA-WEBHOOK-SIGNATURE verification). */
  taigaWebhookSecret?: string;
  /** Secret tokens of the GitLab webhooks (X-Gitlab-Token). Empty list = no verification. */
  gitlabWebhookSecrets?: string[];
  /** Plane API clients keyed by provider ref ("plane:<alias>"). Enables multiple Plane instances. */
  planeClients?: Map<string, IPlaneApiClient>;
  /** Taiga API clients keyed by provider ref ("taiga:<alias>"). */
  taigaClients?: Map<string, ITaigaApiClient>;
  /** GitLab API clients keyed by provider ref ("gitlab:<alias>"). */
  gitlabClients?: Map<string, IGitLabApiClient>;
  /** Bitrix API clients keyed by provider ref ("bitrix:<alias>"). */
  bitrixClients?: Map<string, IBitrixClient>;
  /** Intake API keys keyed by provider ref ("api:<alias>"). Missing entry = endpoint without auth. */
  intakeApiKeys?: Map<string, string>;
  /** Durable pipeline state: `once` guards and branch/MR -> tracker item links. */
  pipelineState?: IPipelineStateStore | null;
}

export function createApp(deps: AppDependencies) {
  const { config, registry, pachkaClient, messageStore, projectIdMap, projectIdentifierMap, memberMap, webhookSecret, taigaWebhookSecret } = deps;
  const planeClients = deps.planeClients ?? new Map<string, IPlaneApiClient>();
  const taigaClients = deps.taigaClients ?? new Map<string, ITaigaApiClient>();
  const gitlabClients = deps.gitlabClients ?? new Map<string, IGitLabApiClient>();
  const bitrixClients = deps.bitrixClients ?? new Map<string, IBitrixClient>();
  const pipelineState = deps.pipelineState ?? null;

  const eventBus = new EventBus();

  // Resolves DM recipients (work email -> Pachka user); needs the API, so it follows the client.
  const userDirectory = pachkaClient ? new PachkaUserDirectory(pachkaClient) : null;

  const useCase = new ProcessPlaneWebhookUseCase(
    config,
    registry,
    pachkaClient,
    messageStore,
    projectIdMap,
    projectIdentifierMap,
    memberMap,
    planeClients,
    taigaClients,
    gitlabClients,
    userDirectory,
    pipelineState,
    bitrixClients,
  );

  const formProviders = registry.getByType("form");

  // Form pipelines may target only pachka/webhook, so form providers alone justify the engine.
  const intakePipeline =
    planeClients.size > 0 ||
    taigaClients.size > 0 ||
    gitlabClients.size > 0 ||
    bitrixClients.size > 0 ||
    formProviders.length > 0
      ? new ProcessIntakePipelineUseCase(
          config,
          registry,
          planeClients,
          pachkaClient,
          messageStore,
          taigaClients,
          gitlabClients,
          userDirectory,
          pipelineState,
          bitrixClients,
        )
      : null;

  // Pipelines whose first step is a Taiga event (`from: "taiga:<alias>"`).
  const hasTaigaTriggers = config.rules.some(
    (pipeline) => pipeline.length > 0 && parseRef(pipeline[0].from).type === "taiga",
  );
  const taigaTrigger =
    intakePipeline && hasTaigaTriggers
      ? new ProcessTaigaTriggerUseCase(config, registry, taigaClients, intakePipeline)
      : null;

  // Pipelines whose first step is a GitLab repository event (`from: "gitlab:<alias>"`).
  const hasGitlabTriggers = config.rules.some(
    (pipeline) => pipeline.length > 0 && parseRef(pipeline[0].from).type === "gitlab",
  );
  const gitlabTrigger =
    intakePipeline && hasGitlabTriggers
      ? new ProcessGitLabTriggerUseCase(config, registry, pipelineState, intakePipeline)
      : null;

  // Mount one intake endpoint per api provider, each triggering its own pipeline (from === "api:<alias>").
  const intakeRoutes = new Elysia();
  if (intakePipeline) {
    for (const api of registry.getByType("api") as ApiProvider[]) {
      intakeRoutes.use(
        intakeIssueRoute({
          intakePipeline,
          endpoint: api.endpoint,
          triggerRef: `api:${api.alias}`,
          apiKey: deps.intakeApiKeys?.get(`api:${api.alias}`),
          fields: api.fields,
        }),
      );
    }
  }

  return new Elysia()
    .onError(({ error, code }) => {
      if (code === "NOT_FOUND") return;
      log.error("Unhandled error", { error: String(error) });
      return { ok: false, error: String(error) };
    })
    .get("/health", () => ({ ok: true }))
    .use(planeWebhookRoute({ useCase, eventBus, webhookSecret }))
    .use(taigaWebhookRoute({
      useCase: new ProcessTaigaWebhookUseCase(
        registry, pachkaClient, messageStore, config, pipelineState,
      ),
      trigger: taigaTrigger,
      webhookSecret: taigaWebhookSecret,
    }))
    .use(gitlabWebhookRoute({
      trigger: gitlabTrigger,
      secrets: deps.gitlabWebhookSecrets,
    }))
    .use(pachkaCallbackRoute({
      messengerClient: pachkaClient,
      messageStore,
      taigaFeedback: taigaClients.size > 0
        ? new HandleTaigaFeedbackUseCase(
            registry, taigaClients, pachkaClient, config, messageStore, pipelineState,
          )
        : null,
      openFormView: pachkaClient && formProviders.length > 0
        ? new OpenFormViewUseCase(registry, pachkaClient, messageStore)
        : null,
      formSubmission: intakePipeline && formProviders.length > 0
        ? new ProcessFormSubmissionUseCase(config, intakePipeline, pachkaClient)
        : null,
    }))
    .use(intakeRoutes);
}
