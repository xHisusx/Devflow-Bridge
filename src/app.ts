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
import { taigaWebhookRoute } from "./modules/taiga/infrastructure/webhooks/taiga-webhook.route";
import type { IPlaneApiClient } from "./modules/plane/application/ports/plane-api.port";
import type { ITaigaApiClient } from "./modules/taiga/application/ports/taiga-api.port";
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
  /** Plane API clients keyed by provider ref ("plane:<alias>"). Enables multiple Plane instances. */
  planeClients?: Map<string, IPlaneApiClient>;
  /** Taiga API clients keyed by provider ref ("taiga:<alias>"). */
  taigaClients?: Map<string, ITaigaApiClient>;
  /** Intake API keys keyed by provider ref ("api:<alias>"). Missing entry = endpoint without auth. */
  intakeApiKeys?: Map<string, string>;
}

export function createApp(deps: AppDependencies) {
  const { config, registry, pachkaClient, messageStore, projectIdMap, projectIdentifierMap, memberMap, webhookSecret, taigaWebhookSecret } = deps;
  const planeClients = deps.planeClients ?? new Map<string, IPlaneApiClient>();
  const taigaClients = deps.taigaClients ?? new Map<string, ITaigaApiClient>();

  const eventBus = new EventBus();

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
  );

  const formProviders = registry.getByType("form");

  // Form pipelines may target only pachka/webhook, so form providers alone justify the engine.
  const intakePipeline = planeClients.size > 0 || taigaClients.size > 0 || formProviders.length > 0
    ? new ProcessIntakePipelineUseCase(
        config,
        registry,
        planeClients,
        pachkaClient,
        messageStore,
        taigaClients,
      )
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
      useCase: new ProcessTaigaWebhookUseCase(registry, pachkaClient, messageStore, config),
      webhookSecret: taigaWebhookSecret,
    }))
    .use(pachkaCallbackRoute({
      messengerClient: pachkaClient,
      messageStore,
      taigaFeedback: taigaClients.size > 0
        ? new HandleTaigaFeedbackUseCase(registry, taigaClients, pachkaClient, config, messageStore)
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
