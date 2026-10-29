# plane-pachka

Мост между Plane (project management) и Пачкой (мессенджер). Принимает вебхуки от Plane, фильтрует по правилам, отправляет уведомления в Пачку.

## Стек

- Runtime: Bun
- Framework: Elysia
- Language: TypeScript
- БД: bun:sqlite (хранение ID отправленных сообщений)

## Команды

```bash
bun install          # установка зависимостей
bun run dev          # запуск с hot reload
bun run start        # production
bun test             # все тесты (unit + e2e)
bun test tests/unit/ # только unit-тесты
bun test tests/e2e/  # только e2e-тесты (требуют PACHKA_TEST_TOKEN)
```

## Архитектура

Модульный монолит + Clean Architecture. Event-driven подход через EventBus.

### Корень

- `src/index.ts` — composition root: загрузка конфига, инициализация клиентов, запуск сервера
- `src/app.ts` — фабрика приложения `createApp()`, монтирует route-модули через `.use()`

### Core (`src/core/`)

- `logger.ts` — структурированный логгер (debug/info/warn/error)
- `env.ts` — `loadDotEnv()`: `.env` перекрывает переменные, унаследованные от шелла
- `config.ts` — типы конфига (`Config`, `PachkaConfig`), `loadConfig()`, `validateConfig()`
- `provider-schema.ts` — `PROVIDER_OUTPUTS`, `getProviderOutputs()`, `GITLAB_COMPUTED_VARS`
- `slug.ts` — транслитерация ru→lat, `slugify()`, `initials()` (имена ветвей GitLab), `nameKey()` (сверка людей по имени)
- `pipeline.ts` — `filterOutputs()`, `onceKey()` (ключ guard-а `once`)
- `persistence/pipeline-state.port.ts` — интерфейс `IPipelineStateStore` (`once`-ключи, связи ветка/MR → задача)
- `persistence/sqlite-pipeline-state.ts` — `PipelineStateStore` (bun:sqlite, `PIPELINE_DB_PATH`)
- `events/event-bus.ts` — typed EventBus для межмодульного взаимодействия

### Модуль Plane (`src/modules/plane/`)

- `domain/entities/` — `PlaneIssue`, `PlaneState`, `PlaneProject`, `PlaneMember`, `PlaneWebhookPayload`
- `domain/services/rule-matcher.ts` — `matchesCondition()`, `asArray()` (чистые функции)
- `domain/services/template-renderer.ts` — `renderMessage()`, `DEFAULT_TEMPLATE`
- `domain/services/deduplicator.ts` — дедупликация вебхуков (Map + TTL)
- `domain/events/plane-events.ts` — доменные события (`PlaneWebhookReceived`)
- `application/ports/plane-api.port.ts` — интерфейс `IPlaneApiClient`
- `application/use-cases/process-plane-webhook.ts` — `ProcessPlaneWebhookUseCase`
- `application/use-cases/process-intake-pipeline.ts` — `ProcessIntakePipelineUseCase` (intake pipeline: Plane + notifications)
- `infrastructure/clients/plane-api-client.ts` — `PlaneClient` (implements `IPlaneApiClient`)
- `infrastructure/services/webhook-verifier.ts` — проверка HMAC подписи
- `infrastructure/webhooks/plane-webhook.route.ts` — Elysia-plugin: `POST /webhook/plane`

### Модуль Messenger (`src/modules/messenger/`)

- `domain/entities/` — `PachkaMessage`, `PachkaButton`, `PachkaThread`, `Rule`, `RuleAction`, `RuleCondition`
- `domain/entities/form.ts` — типы форм (`FormBlock`, `FormViewPayload`), хелперы callbackData/callback_id
- `domain/services/action-executor.ts` — `extractButtons()`, `keepLinkButtons()` (чистая логика кнопок)
- `application/ports/messenger-client.port.ts` — интерфейс `IMessengerClient`
- `application/ports/message-store.port.ts` — интерфейс `IMessageStore`
- `application/use-cases/execute-actions.ts` — `executeActions()` (reaction, threadReply, editPrevious)
- `application/use-cases/open-form-view.ts` — `OpenFormViewUseCase` (открытие модальной формы по кнопке)
- `application/use-cases/process-form-submission.ts` — `ProcessFormSubmissionUseCase` (отправка формы → пайплайн)
- `application/services/pachka-user-directory.ts` — `PachkaUserDirectory` (email → user id), `workEmailOf()`
- `application/services/resolve-pachka-target.ts` — `resolvePachkaTarget()` (чат или ЛС для notify-шага)
- `infrastructure/clients/pachka-api-client.ts` — `PachkaClient` (implements `IMessengerClient`)
- `infrastructure/clients/pachka-webhook-sender.ts` — legacy webhook отправка
- `infrastructure/persistence/sqlite-message-store.ts` — `MessageStore` (implements `IMessageStore`)
- `infrastructure/webhooks/pachka-callback.route.ts` — Elysia-plugin: `POST /webhook/pachka`

### Модуль Taiga (`src/modules/taiga/`)

- `domain/entities/taiga-webhook-payload.ts` — тип payload вебхука Taiga
- `domain/services/taiga-trigger.ts` — `extractTaigaFacts()`, `matchesTaigaCondition()`, `buildTaigaTriggerOutputs()`, `normalizeTaigaEntity()`, `extractProjectSlug()`, `milestoneName()`, `normalizeTags()` (чистые функции)
- `domain/services/feedback-buttons.ts` — `buildFeedbackButtons()`, `buttonsForStatus()`, `statusLabel()`, `buildItemUrl()`
- `application/ports/taiga-api.port.ts` — интерфейс `ITaigaApiClient`
- `application/services/create-taiga-issue.ts` — `createTaigaIssueFromContent()`, `TaigaWriteError` (создание item + сборка outputs)
- `application/services/update-taiga-item.ts` — `updateTaigaItemFromContent()` (обновление: кастомные поля, статус, исполнитель, комментарий; неизвестное поле — warning, не ошибка)
- `application/services/story-progress.ts` — `storyTaskProgress()` (сколько задач user story в нужных статусах; история без задач не считается готовой)
- `application/use-cases/process-taiga-trigger.ts` — `ProcessTaigaTriggerUseCase` (вебхук Taiga как триггер пайплайна, резолв email исполнителя через memberships)
- `application/use-cases/process-taiga-webhook.ts` — `ProcessTaigaWebhookUseCase` (синхронизация карточки в Пачке)
- `infrastructure/clients/taiga-api-client.ts` — `TaigaApiClient` (адаптер над npm-библиотекой `taiga-api-client`; кастомные атрибуты — через `sdk.http`)

### Модуль GitLab (`src/modules/gitlab/`)

- `domain/entities/gitlab-webhook-payload.ts` — типы payload вебхуков GitLab (merge_request, push, ...)
- `domain/services/branch-name.ts` — `resolveRepo()`, `resolveBranchType()`, `buildBranchName()`, `sanitizeBranchName()`, `missingBranchVars()`, `draftTitle()` (чистые функции)
- `domain/services/gitlab-trigger.ts` — `extractGitLabFacts()`, `matchesGitLabCondition()`, `buildGitLabTriggerOutputs()`, `branchFromRef()` (чистые функции)
- `application/ports/gitlab-api.port.ts` — интерфейс `IGitLabApiClient` (коммиты, ветки, MR, issues, пользователи, участники групп)
- `application/services/run-gitlab-step.ts` — `runGitLabStep()`, `GitLabWriteError` (ветка + MR + issue + комментарий, сборка outputs)
- `application/services/gitlab-user-resolver.ts` — `GitLabUserResolver` (email → пользователь GitLab без админского токена), `usernameCandidates()`
- `application/services/task-links.ts` — `rememberTaskLink()` (ветка/MR → задача трекера)
- `application/use-cases/process-gitlab-trigger.ts` — `ProcessGitLabTriggerUseCase` (вебхук GitLab как триггер пайплайна), `coversRepo()`
- `infrastructure/clients/gitlab-api-client.ts` — `GitLabApiClient` (REST v4 через fetch), `GitLabApiError`
- `infrastructure/webhooks/gitlab-webhook.route.ts` — Elysia-plugin: `POST /webhook/gitlab`

### Модуль Bitrix (`src/modules/bitrix/`)

- `domain/entities/status.ts` — `StatusType`, `BitrixStatusRequest`, `BitrixStatusResponse`
- `application/ports/bitrix-api.port.ts` — интерфейс `IBitrixClient`
- `application/services/update-bitrix-status.ts` — `parseBitrixIdFromDescription()` (BitrixID из описания задачи), `updateBitrixStatusFromTaiga()`, `BitrixMappingError`
- `infrastructure/clients/bitrix-api-client.ts` — `BitrixApiClient` (implements `IBitrixClient`, `PUT /support/appeal/status/`)

### Модуль GitHub (`src/modules/github/`) — заглушка для будущей интеграции

### Принципы

- `domain/` — чистая бизнес-логика, без зависимостей от фреймворков
- `application/` — use cases, оркестрация domain-сервисов через port-интерфейсы
- `infrastructure/` — Elysia-роуты, API-клиенты, SQLite, конкретные реализации портов
- Хендлеры = парсинг + валидация + вызов use case
- Бизнес-логика тестируема без HTTP/DB

## Два режима доставки

1. **Webhook** — только текст, target указан в `config.webhooks`
2. **API** — кнопки, реакции, треды, редактирование. Target указан в `config.pachka.chatIds`, требует `PACHKA_API_TOKEN`

## Тестирование

### Требования

- **После любых изменений кода** необходимо запустить `bun test` и убедиться, что все тесты проходят
- При добавлении новой функциональности — писать тесты (unit и/или e2e)
- При исправлении бага — добавить тест, воспроизводящий баг

### Настройка E2E

E2E-тесты отправляют реальные сообщения в Пачку и верифицируют через API. Требуют:

- `PACHKA_TEST_TOKEN` — отдельный бот-токен для тестов
- `PACHKA_TEST_CHAT_ID` — ID тестового чата

Настройки хранятся в `.env.test` (не коммитится, см. `.env.test.example`).

### Структура тестов

- `tests/helpers.ts` — утилиты: создание payload, ожидание сообщений, cleanup
- `tests/mocks.ts` — общие моки портов (`messengerClientMock`, `taigaClientMock`, `gitlabClientMock`, `bitrixClientMock`, `messageStoreMock`, `pipelineStateMock`, `pachkaMessage`)
- `tests/unit/core/` — тесты core (logger, slug, provider-schema drift guards)
- `tests/unit/plane/` — тесты plane domain (rule-matcher, template-renderer)
- `tests/unit/taiga/` — тесты taiga (триггер, feedback, создание/обновление item, роллап user story и карточка тестировщиков в `story-rollup.test.ts`)
- `tests/unit/gitlab/` — тесты gitlab-шага, триггера, резолва пользователей и сквозные сценарии «назначение → ветка + MR + ЛС» и «MR влит → статус в Taiga»
- `tests/unit/bitrix/` — тесты bitrix (разбор BitrixID, шаг `to: bitrix:*`, сквозной сценарий «закрытие в Taiga → статус обращения» через `createApp`)
- `tests/unit/messenger/` — тесты messenger (message-store, формы, ЛС)
- `tests/e2e/` — полный цикл: webhook -> сервер -> Pachka API -> проверка

### Правила написания тестов

1. E2E тесты ОБЯЗАНЫ очищать отправленные сообщения в `afterAll`
2. Каждый тест-файл запускает свой экземпляр сервера на случайном порту (`app.listen(0)`)
3. Для SQLite использовать `:memory:` или уникальный путь
4. Для ожидания сообщений использовать `waitForMessage()` с таймаутом
5. Unit-тесты не требуют внешних сервисов и должны работать без `.env.test`

## Логирование

- Используется `src/core/logger.ts` с уровнями `debug | info | warn | error`
- Production (по умолчанию): уровень `info` — debug-сообщения скрыты
- Тесты (`NODE_ENV=test`): уровень `debug` — все сообщения видны
- Переопределение: `LOG_LEVEL=debug` (или `warn`, `error`)
- Формат: `ISO_TIMESTAMP [LEVEL] message {context}`

---

# Генерация config.json

Конфиг ищется в порядке: `CONFIG_PATH` (env) → `config/default.json` → `config.json` (legacy). Рабочее расположение — папка `config/` (в git не попадает, см. `.gitignore`; в Docker монтируется томом `./config:/app/config:ro`).

## Схема config.json

```jsonc
{
  "plane": {
    "baseUrl": "string (URL инстанса Plane)"
  },
  "webhooks": {
    // имя → URL incoming webhook (для webhook-режима)
    "target-name": "https://api.pachca.com/webhooks/..."
  },
  "pachka": {
    // имя → числовой ID чата (для API-режима)
    "chatIds": {
      "target-name": 12345678
    }
  },
  "rules": [
    // Rule[][] — массив pipeline-ов. Каждый pipeline = массив правил, выполняемых последовательно.
    // Один элемент = одиночное правило. Несколько = pipeline с передачей данных между шагами.
    [
      {
        "from": "plane | api:intake",       // обязателен: источник события
        "to": "plane | pachka:<ch> | webhook:<name>",  // обязателен: получатель
        "workspace": "string (slug воркспейса)",
        "project": "string (имя проекта)",
        "on": {
          // Условия (для фильтрации) + content (для действия)
          "action": "create | update | delete",
        "entity": "issue | work_item | task | ...",
        "state": "string | string[]",
        "stateGroup": "backlog | unstarted | started | completed | cancelled",
        "priority": "urgent | high | medium | low | none",
        "content": {
          // Содержимое зависит от to:
          // Для to: "plane" — маппинг полей (PlaneContent)
          // Для to: "pachka:*" / "webhook:*" — шаблон уведомления (NotifyContent)
        }
      }
      }
    ]
  ]
}
```

## Плейсхолдеры для шаблонов

Используются в `message`, `actions[].message`, `actions[].buttons[].text`, `actions[].buttons[].url`:

| Плейсхолдер | Значение |
|---|---|
| `{{project}}` | Имя проекта |
| `{{seq}}` | Номер задачи |
| `{{title}}` | Название задачи |
| `{{state}}` | Состояние (Done, In Progress...) |
| `{{stateGroup}}` | Группа состояния (completed, started...) |
| `{{priority}}` | Приоритет (urgent, high, medium, low, none) |
| `{{action}}` | Действие (create, update, delete) |
| `{{entity}}` | Тип сущности (issue, work_item...) |
| `{{issueId}}` | UUID задачи |
| `{{issueUrl}}` | Ссылка на задачу в Plane |

## Типы actions

```jsonc
// Реакция эмодзи на сообщение
{ "type": "reaction", "emoji": "✅" }
// emoji — юникод-символ, НЕ текстовый код

// Ответ в тред сообщения
{ "type": "threadReply", "message": "{{state}}" }

// Кнопки (добавляются к основному сообщению)
{ "type": "buttons", "buttons": [
  { "text": "Текст кнопки", "url": "{{issueUrl}}" },           // кнопка-ссылка
  { "text": "Текст", "callbackData": "action:{{issueId}}" }    // интерактивная
]}

// Редактирование ранее отправленного сообщения по этой задаче.
// Кнопки-действия у него снимаются (ссылки остаются): устаревшая карточка не должна
// менять статус в трекере, продолжая показывать старое состояние.
{ "type": "editPrevious", "message": "⤵️ Карточка устарела — актуальная ниже" }

// Закрепление (зарезервировано)
{ "type": "pin" }
```

## Нотация from/to (pipeline)

Формат: `"<система>:<уточнение>"` — namespace через двоеточие. Все поля обязательны.

### `from` — источник события
| Значение | Описание |
|---|---|
| `"plane"` | Plane (через webhook) |
| `"taiga:<alias>"` | Вебхук Taiga: событие item'а (создание, назначение, смена статуса, закрытие). Условия: `action` (`create`/`change`/`close`/`delete`; закрытие приходит отдельным `close` без диффа), `entity` (`issue`/`user_story`/`task`), `status`, `type`, `priority`, `changed` (поле в диффе), `tags` (есть хотя бы один из тегов), `assigned` (`first`/`any`/`none`), `sprint` (`any`/`none`/имя; у task берётся спринт родительской user story), `allTasks` (все задачи user story события — у task родительской, у user story её самой — в перечисленных статусах; стоит запрос к API, поэтому проверяется последним, а история без задач не проходит никогда), `parentStatus` (статус родительской user story события-задачи; приходит в payload, поэтому бесплатен — у событий других сущностей пуст, так что правило с этим условием на них не срабатывает) |
| `"gitlab:<alias>"` | Вебхук GitLab: событие репозитория (MR открыт/смержен/закрыт, push). Условия: `event`, `action`, `state`, `target`, `branch`, `draft`, `labels` |
| `"api:intake"` | API endpoint `/api/plane/intake-issues` |
| `"form:<alias>"` | Отправка формы Пачки (модального представления) провайдера `form:<alias>` |

### `to` — получатель/действие
| Значение | Описание |
|---|---|
| `"plane:<alias>"` | Создать задачу в Plane-провайдере `<alias>` (workspace/project из провайдера). Работает и в intake-, и в webhook-пайплайнах (последнее = mirror/escalate: создать задачу по событию). Использует тот же путь создания, что и intake. |
| `"taiga:<alias>"` | Создать item в Taiga-провайдере `<alias>` (issue / user story / task — тип задаётся полем `entity` провайдера, по умолчанию `issue`). Если в `content` есть `item` — не создать, а **обновить** существующий item (`customFields`, `status`, `assigneeEmail`, `comment`); кастомное поле, чей шаблон разрешился в пустую строку, остаётся как было (автоматическая запись не стирает данные). Работает и в intake-, и в webhook-пайплайнах. Attachments не поддерживаются. |
| `"gitlab:<alias>"` | Операции в репозитории GitLab-провайдера `<alias>`: `branch` (создать/переиспользовать), `mr` (создать/переиспользовать draft MR), `issue`, `comment` (нота к MR) |
| `"bitrix:<alias>"` | Проставить статус обращения Bitrix (`Closed` / `Rejected`). Id обращения берётся из описания задачи (`**BitrixID:** 12345`), а не из `content`; без него шаг пропускается с warning |
| `"pachka:<channel>"` | Уведомить в Пачку, channel = alias `pachka`-провайдера. У провайдера с `"dm": true` — в ЛС получателю из `content.recipient` (рабочая почта или user id) |
| `"webhook:<name>"` | Отправить через webhook, name = alias `webhook`-провайдера |

### Plane API-ключи (несколько инстансов)

Каждый `plane`-провайдер получает свой клиент (`baseUrl` из провайдера + ключ). Ключ резолвится из env: `PLANE_API_KEY_<ALIAS>` (alias в верхнем регистре, не-буквенно-цифровые → `_`), с откатом на общий `PLANE_API_KEY`. Это позволяет подключать разные Plane-инстансы с разной авторизацией. Если для провайдера не найдено ни одного ключа — старт падает с ошибкой.

### Taiga-провайдер

```jsonc
{
  "type": "taiga",
  "alias": "support",
  "baseUrl": "https://api.taiga.io",   // корень инстанса Taiga (без /api/v1)
  "project": "my-project-slug",        // slug проекта
  "webUrl": "https://tree.taiga.io",   // опционально: корень web-UI для ссылок (по умолчанию baseUrl)
  "entity": "issue",                   // "issue" | "user_story" | "task", по умолчанию "issue"
  "priorityLabels": {                  // опционально: имя приоритета Taiga → отображение в сообщениях
    "Normal": "Обычная",
    "Critical": "Критическая"
  }
}
```

Креды резолвятся из env по той же схеме, что у Plane: `TAIGA_APP_TOKEN_<ALIAS>` (application token) либо `TAIGA_USERNAME_<ALIAS>` + `TAIGA_PASSWORD_<ALIAS>` (логин при старте), с откатом на общие `TAIGA_APP_TOKEN` / `TAIGA_USERNAME` / `TAIGA_PASSWORD`. Если кредов нет — старт падает. Поле `labels` в content маппится в tags Taiga (резолв по имени не нужен, теги создаются на лету). Поле `type` в content (только для `entity: "issue"`) задаёт тип запроса по имени из справочника типов проекта («Ошибка», «Вопрос»...), без учёта регистра; неизвестный тип — ошибка 400 со списком доступных; если поле пустое/отсутствует — тип по умолчанию. Поле `priority` в content (только для `entity: "issue"`) аналогично задаёт приоритет задачи по имени из справочника приоритетов проекта («Low», «Normal», «High», «Critical»...), без учёта регистра; неизвестный приоритет — ошибка со списком доступных. В outputs шага `priority` отдаётся уже с применённым `priorityLabels` (или сырое имя, «—» если приоритет не определён).

### GitLab-провайдер

```jsonc
{
  "type": "gitlab",
  "alias": "backend",
  "baseUrl": "https://git.example.com",   // корень инстанса (/api/v4 добавляется клиентом)
  "project": "team/backend",              // репозиторий по умолчанию (path или numeric id)
  "repoByTag": { "frontend": "team/web" },// тег задачи → репозиторий (первое совпадение)
  "defaultBranch": "master",              // база ветвей и target MR (по умолчанию "master")
  "branch": { "pattern": "{{branchType}}/{{assigneeInitials}}/{{slug}}", "maxSlugLength": 60,
              "typeByTag": { "баг": "fix", "Bug": "fix" }, "type": "feat" },
  "mr": { "draft": true, "title": "{{taskIdentifier}} {{taskName}}", "removeSourceBranch": true },
  "groups": ["team"],                     // группы, среди участников которых искать исполнителя
  "userMap": { "a.makhov@example.com": { "username": "amakhov", "initials": "am" } }
}
```

Токен из env: `GITLAB_TOKEN_<ALIAS>` с откатом на `GITLAB_TOKEN` (схема как у Plane/Taiga); нет токена — старт падает. Секрет вебхука — `GITLAB_WEBHOOK_SECRET[_<ALIAS>]`.

- Админский PAT не обязателен: хватает group access token с ролью Developer и скоупом `api` (на self-managed доступен в любой редакции), project access token или PAT бота, добавленного в группу как Developer.
- Исполнитель ищется по порядку: `userMap` → `GET /users?search=<email>` (приватный email — только админским токеном) → участники `groups` (или самого репозитория) по email, по username из локальной части email, по огрублённому имени (`nameKey`: «Алексей Махов» = «Alexey Makhov») → `GET /users?username=<кандидат>`. Никого не нашли — MR без исполнителя и warning в лог. Индекс участников кешируется на 10 минут.
- Draft задаётся префиксом `Draft: ` в заголовке — в GitLab API нет флага `draft` при создании MR.
- Ветка и MR идемпотентны: существующая ветка переиспользуется, открытый MR по этой ветке — тоже.
- Ошибка создания MR не роняет шаг: ветка остаётся, `mrUrl` пустой, причина — в логе.
- Все плейсхолдеры шаблона ветки обязаны разрешиться, иначе `GitLabWriteError` (чтобы не появлялись ветки вида `feat/`).
- Шаг `to: gitlab:*` запоминает связь `репозиторий + ветка → задача трекера` (+ iid MR) в `PipelineStateStore`. Это единственный путь обратно: в вебхуках GitLab id задачи нет.

### Bitrix-провайдер

```jsonc
{
  "type": "bitrix",
  "alias": "support",
  "baseUrl": "https://portal.example.com/api/v1"   // корень API, без пути /support/appeal/status/
}
```

Токен из env: `BITRIX_API_TOKEN_<ALIAS>` с откатом на `BITRIX_API_TOKEN` (схема как у Plane/Taiga/GitLab); нет токена — старт падает.

Провайдер умеет одно — проставить статус обращения (`PUT /support/appeal/status/`), т.е. замкнуть intake-поток «заявка из Bitrix → задача в трекере». `content`: `status` (`"Closed"` | `"Rejected"`, обязателен, проверяется валидацией конфига) и `resolution` (опционально, default «Статус изменён в Taiga»).

Id обращения в `content` не передаётся — шаг читает его из `description` источника (`**BitrixID:** 12345`, также `BitrixID: 12345` и `**Bitrix ID:** 12345`), туда его кладёт intake-шаг. Задача без BitrixID — не ошибка: шаг пропускается с warning (`BitrixMappingError`), потому что не каждая заявка приходит из Bitrix.

Типовой сценарий — «задачу закрыли в Taiga → закрыть обращение» (Taiga присылает закрытие отдельным событием `close`, поэтому условие именно `"action": "close"`, а разделяет случаи `status`):

```json
{
  "from": "taiga:ikn", "to": "bitrix:support",
  "on": {
    "action": "close", "status": "Closed",
    "content": { "status": "Closed", "resolution": "Обращение закрыто в Taiga" }
  }
}
```

### Вебхук GitLab → триггер пайплайна

`POST /webhook/gitlab` (`src/modules/gitlab/infrastructure/webhooks/gitlab-webhook.route.ts`) запускает пайплайны с первым шагом `from: "gitlab:<alias>"`. Настройка: **Settings → Webhooks** в проекте (в группе — только Premium/Ultimate; один хук на весь инстанс с одним секретом — **Admin Area → System Hooks**, доступно в любой редакции), URL `https://<хост>/webhook/gitlab`, Secret token = `GITLAB_WEBHOOK_SECRET[_<ALIAS>]` (GitLab присылает его как есть в `X-Gitlab-Token`, подписи нет), триггеры *Merge request events* / *Push events*. Нет секретов в env — проверка отключена (warning при старте). Провайдер выбирается по репозиторию: `project`, значения `repoByTag` или всё внутри `groups` (`coversRepo()`).

Типовой обратный сценарий — «MR влит → статус в Taiga»:

```json
{
  "from": "gitlab:backend", "to": "taiga:dev",
  "on": {
    "event": "merge_request", "action": "merge", "target": "master",
    "content": { "item": "{{taskId}}", "status": "Done", "comment": "MR {{mrUrl}} влит" }
  }
}
```

### `once` — шаг только один раз

`on.once: true` — шаг выполняется один раз на задачу и получателя (ключ: шаг + `issueId`/`taskId` + отрендеренный `recipient`); `on.once: "<шаблон>"` — ключ задаётся явно. Ключи в SQLite (`PIPELINE_DB_PATH`), занимаются до выполнения шага и освобождаются при его падении. Нужен, чтобы повторное назначение задачи не присылало человеку второе ЛС (ветка и MR идемпотентны сами). Шаги, читающие `from` пропущенного шага, пропускаются вместе с ним.

### Личные сообщения в Пачку (`dm`)

```jsonc
{ "type": "pachka", "alias": "dev-dm", "dm": true, "workEmailField": "Рабочая почта" }
```

Провайдер без `chatId`; получатель — в `content.recipient` шага (рабочая почта или числовой user id). Поиск: `GET /users?query=<email>`, затем полный список сотрудников со сверкой кастомного поля (кеш 10 минут). Нужен скоуп `users:read`, отправка — `POST /messages` с `entity_type: "user"`. Получатель не найден — шаг пропускается с warning.

### Обратная связь Пачка → Taiga (feedback)

Кнопки в сообщении Пачки меняют статус item'а в Taiga. Настраивается блоком `feedback` на taiga-провайдере:

```jsonc
"feedback": {
  "statuses": {                    // действие → имя статуса в Taiga (без учёта регистра)
    "accept": "In progress",
    "pause": "On pause",
    "close": "Closed",
    "resume": "In progress"
  },
  "buttons": {                     // имя статуса → кнопки после перехода (нет ключа = кнопки убираются)
    "In progress": [
      { "text": "⏹️ Поставить на паузу", "action": "pause" },
      { "text": "✅ Завершить", "action": "close" }
    ],
    "On pause": [{ "text": "🚀 Возобновить", "action": "resume" }]
  },
  "workEmailField": "Рабочая почта"  // кастомное поле профиля Пачки с рабочей почтой
}
```

Механика:

1. Стартовая кнопка задаётся в notify-шаге пайплайна: `{ "text": "👍 Взять в работу", "callbackData": "taiga:<alias>:accept:{{issueId}}" }`. Формат callbackData: `taiga:<alias>:<action>:<itemId>`.
2. Нажатие прилетает в `POST /webhook/pachka` (исходящий webhook Пачки должен указывать на этот роут) и обрабатывается `HandleTaigaFeedbackUseCase` (`src/modules/taiga/application/use-cases/handle-taiga-feedback.ts`).
3. Действия `accept` и `resume` дополнительно назначают исполнителя: у нажавшего берётся email из кастомного поля `workEmailField` (fallback — email профиля), участник проекта Taiga ищется по `user_email` (связь пользователей по email, не по id).
4. После перехода кнопки-действия заменяются набором для нового статуса (нет ключа = кнопки убираются, кнопки-ссылки сообщение сохраняет); статус ищется среди статусов проекта по имени. Набор берётся из `content.buttonsByStatus` того notify-шага, который отправил эту карточку, а если шаг его не объявил — из `feedback.buttons` провайдера. Это нужно, когда один item показан в нескольких местах сразу: в канале тестировщиков у карточки свои действия, в ЛС разработчика — свои.
5. Имена действий свободные — семантика фиксирована только для `accept`/`resume` (назначение исполнителя), остальные просто меняют статус.
6. `feedback.statusLabels` — отображаемые имена статусов для сообщений (`"In progress": "В процессе 🚀"`).
7. Outputs taiga-шага включают `status` (label), `assignee`, `type` (тип issue из Taiga: «Ошибка», «Вопрос»...) — можно использовать в шаблоне уведомления для «живой карточки».
8. При переходе статуса (клик по кнопке или вебхук Taiga) текст сообщения **перерисовывается** по шаблону `content.message` со свежими `{{status}}`/`{{assignee}}`/`{{type}}`. Шаблон ищется у правила `taiga:<alias> → pachka:<target>`, а если такого нет — у шага `… → pachka:<target>` пайплайна, который запускает этот же taiga-провайдер (так перерисовывается ЛС, отправленное шагом `from: gitlab:*`). В шаблоне доступны `task*` (`taskProject`, `taskIdentifier`, `taskName`, `taskUrl`, `taskStatus`) и `repo`/`branch`/`mrUrl` из связи «ветка/MR → задача»; если шаблон не найден — текст сохраняется, меняются только кнопки.

### Вебхук Taiga → синхронизация кнопок

`POST /webhook/taiga` принимает вебхуки Taiga (`src/modules/taiga/infrastructure/webhooks/taiga-webhook.route.ts`). При смене статуса item'а в самой Taiga (вручную или после нажатия кнопки) кнопки отслеживаемого сообщения в Пачке заменяются набором из `feedback.buttons` для нового статуса — кнопки не расходятся с реальным состоянием (`ProcessTaigaWebhookUseCase`).

Настройка вебхука в Taiga (Settings → Integrations → Webhooks):
- **URL**: `https://<хост-сервиса>/webhook/taiga`
- **Secret key**: произвольная строка; та же строка должна быть в env `TAIGA_WEBHOOK_SECRET`. Подпись — HMAC-SHA1 от raw body в заголовке `X-TAIGA-WEBHOOK-SIGNATURE`; при пустом `TAIGA_WEBHOOK_SECRET` подпись не проверяется.

Провайдер события определяется по slug проекта из `data.project.permalink` и по `entity` (один проект бывает подключён двумя провайдерами — задачи и user story, — и карточка относится к тому, чья сущность совпала с сущностью события); тестовый пинг Taiga (`action: "test"`) отвечает `200 ok`.

Синхронизация сообщения (`ProcessTaigaWebhookUseCase`) и запуск пайплайнов (`ProcessTaigaTriggerUseCase`) — две независимые ветки одного роута: одно событие может и перерисовать карточку, и запустить пайплайн, и падение одной не скрывает другую. Но не параллельные: сначала пайплайны, потом синхронизация — пайплайн может заменить карточку (отправить новую, свернуть старую), и синхронизация должна работать с актуальной, иначе два редактирования гоняются за одно сообщение. Ответ: `{ "ok": true, "updated": <сообщений>, "triggered": <пайплайнов> }`. Всё, что запускается событием Taiga (в том числе `to: bitrix:*`), идёт через триггер и общий движок пайплайнов, а не отдельным путём.

### Формы Пачки (модальные представления)

Декларативная поддержка [форм Пачки](https://dev.pachca.com/guides/forms/overview): кнопка в сообщении бота открывает модальную форму, отправка формы запускает пайплайн. Требуется `PACHKA_API_TOKEN` со скоупом `views:write`; исходящий вебхук Пачки должен указывать на `POST /webhook/pachka`.

**Провайдер `form`** — декларация формы. Объёмное определение выносится в отдельный файл (рекомендуется `config/forms/*.json`, путь относительно директории конфига); маленькие формы можно описывать inline через `blocks`:

```jsonc
{
  "type": "form",
  "alias": "support-request",
  "file": "forms/support-request.json"  // либо inline: "title", "submitText", "closeText", "blocks"
}
```

Файл формы (`config/forms/support-request.json`) — нативный формат Пачки (блоки snake_case, pass-through в `POST /views/open`; ключи `submit_text`/`submitText` равнозначны):

```jsonc
{
  "title": "Новая заявка",            // ≤24 символов
  "submit_text": "Отправить",
  "close_text": "Отмена",
  "blocks": [                          // ≤100 блоков: header, plain_text, markdown, divider,
    { "type": "input", "name": "summary", "label": "Кратко", "required": true },
    { "type": "select", "name": "category", "label": "Категория",
      "options": [{ "text": "Ошибка", "value": "bug" }, { "text": "Вопрос", "value": "question" }] }
  ]                                    // input, select, radio, checkbox, date, time, file_input
}
```

Inline-поля провайдера имеют приоритет над полями файла. Отсутствующий файл или форма без `blocks` — ошибка старта.

**Кнопка открытия** — поле `form` в кнопке notify-шага (взаимоисключимо с `url`/`callbackData`):

```json
{ "type": "buttons", "buttons": [{ "text": "📝 Заполнить заявку", "form": "support-request" }] }
```

**Отправка формы = триггер пайплайна.** Пайплайн с первым шагом `from: "form:<alias>"` получает outputs:

| Поле | Значение |
|---|---|
| `{{data.<name>}}` | Значения полей формы по `name` блока. Значения file_input нормализуются в строку markdown-ссылок `[имя](url), ...` (URL действительны 1 час) |
| `{{user}}` / `{{user.first_name}}` | Профиль нажавшего (best-effort через API, может быть null) |
| `{{userId}}` / `{{chatId}}` | ID пользователя и чата |
| `{{receivedAt}}` | Время отправки ("11.07.2026 08:03") |
| `{{meta.*}}` | Корреляция из private_metadata: `formRef`, `messageId`, `chatId`, `correlationId`, `target` (если форма открыта с отслеживаемого сообщения) |

Пример полного цикла (кнопка на уведомлении → форма → задача в Plane + уведомление):

```json
[
  {
    "from": "form:support-request", "to": "plane:dev",
    "on": {
      "action": "create", "entity": "task",
      "content": {
        "name": "{{data.summary}}",
        "description": "Категория: {{data.category}}. От {{user.first_name}} ({{receivedAt}})",
        "labels": ["Support"]
      }
    }
  },
  {
    "from": "plane:dev", "to": "pachka:support",
    "on": {
      "action": "create", "entity": "task",
      "content": { "message": "📬 Заявка из формы: {{name}}", "actions": [
        { "type": "buttons", "buttons": [{ "text": "Открыть", "url": "{{issueUrl}}" }] }
      ]}
    }
  }
]
```

Механика: клик по кнопке → вебхук с `trigger_id` (TTL 3 сек) → `OpenFormViewUseCase` синхронно вызывает `POST /views/open` (`callback_id = "form:<alias>"`, корреляция исходного сообщения — в `private_metadata`). Отправка формы → вебхук `{type:"view", event:"submit"}` → мгновенный ответ `200` (закрывает модалку), пайплайн выполняется асинхронно. Валидацию required/min/max выполняет сама Пачка. Ограничения v1: без prefill плейсхолдеров в `initial_value`, файлы file_input не скачиваются (только ссылки), кастомная серверная валидация (`400 {errors}`) не поддерживается.

**Публикация кнопки формы в чат** (например, закреплённое сообщение «Создать заявку»):

```bash
bun run scripts/post-form-button.ts <form-alias> <pachka-alias|chatId> [message] [button-text]
# bun run scripts/post-form-button.ts devops-request devops-support
```

⚠️ Если пайплайн формы ведёт в `to: taiga:*` с маппингом `type`, значения `value` у select-опций формы должны совпадать с именами типов запроса в проекте Taiga (без учёта регистра) — иначе создание item упадёт с «Issue type not found» (форма при этом закроется, ошибка останется только в логах).

### `on.content` — типизирован по target

**Для `to: "plane"` (PlaneContent):** маппинг полей из source
```json
"content": {
  "name": "{{body.name}}",            // "{{path}}" = из source (from: api:intake → { body, files })
  "description": "{{body.description}}",
  "labels": ["Support"],              // статическое значение
  "priority": "medium"
}
```

**Для `to: "pachka:*"` / `to: "webhook:*"` (NotifyContent):** шаблон уведомления
```json
"content": {
  "message": "📬 {{name}} → {{state}}",
  "actions": [
    { "type": "buttons", "buttons": [{ "text": "Открыть", "url": "{{issueUrl}}" }] }
  ]
}
```

## Intake pipeline

Каждый `api`-провайдер монтирует HTTP-эндпоинт `POST <endpoint>` (поле `endpoint` провайдера). Запрос на него запускает тот pipeline, чей первый шаг имеет `from: "api:<alias>"` этого провайдера — то есть можно завести несколько независимых intake-эндпоинтов/пайплайнов.

### Авторизация intake-эндпоинтов

Каждый эндпоинт защищён API-ключом. Ключ резолвится из env по той же схеме, что у Plane/Taiga: `INTAKE_API_KEY_<ALIAS>` (alias в верхнем регистре, не-буквенно-цифровые → `_`), с откатом на общий `INTAKE_API_KEY`. Если ключа нет — старт падает. Провайдер может явно отключить проверку полем `"auth": false` (эндпоинт становится публичным, в лог пишется warning). Ключи в config.json не хранятся.

Клиент передаёт ключ в заголовке `Authorization: Bearer <key>` либо `X-API-Key: <key>`; неверный или отсутствующий ключ — `401 {"ok":false,"error":"Unauthorized"}`. Сравнение — константное по времени (`timingSafeEqual`).

### Валидация тела intake-запроса (`fields`)

`api`-провайдер может декларировать схему полей body — проверяется до запуска пайплайна (`validateIntakeBody`, `src/modules/plane/domain/services/intake-validator.ts`); ошибка → `400 {"ok":false,"error":"..."}`:

```jsonc
{
  "type": "api", "alias": "intake", "endpoint": "/api/taiga/intake",
  "fields": {
    "section": {
      "required": true,                          // отсутствует/пустая строка → 400
      "values": ["Реестр контрактов", "KPI"]     // значение вне списка → 400 (строгое сравнение, с учётом регистра)
    },
    "discoveredAt": {
      "requiredIf": { "field": "type", "value": "Ошибка" }  // обязательно, только если body.type == "Ошибка"
    }
  }
}
```

Пример (`api:intake` → `endpoint: "/api/plane/intake-issues"`) с явным потоком данных:

```json
[
  {
    "from": "api:intake",    // читает { body, files } из входа
    "to": "plane:dev",       // создаёт задачу
    "on": {
      "action": "create", "entity": "task",
      "content": {
        "name": "{{body.name}}",
        "description": "{{body.description}}",
        "labels": "{{body.labels}}"
      }
    }
  },
  {
    "from": "plane:dev",     // читает outputs предыдущего plane:dev шага
    "to": "pachka:support",  // уведомляет
    "on": {
      "action": "create", "entity": "task",
      "content": {
        "message": "📬 {{name}}",
        "actions": [{
          "type": "buttons",
          "buttons": [{ "text": "Открыть", "url": "{{issueUrl}}" }]
        }]
      }
    }
  }
]
```

### Outputs — явная декларация производимых данных

Каждый шаг может декларировать `on.outputs` — список полей, которые он экспонирует следующим шагам. Если `outputs` не указан, экспонируется полная схема провайдера.

**Валидация (строгая):** если следующий шаг использует `{{x}}` в templates, а `x` не в `outputs` предыдущего шага — ошибка.

Схемы провайдеров (встроенные):

| Провайдер | Exposed fields |
|---|---|
| `api:<endpoint>` | `body`, `files`, `receivedAt` (время приёма запроса, "11.07.2026 08:03", серверная TZ) |
| `plane:<alias>` (триггер, первый шаг webhook-пайплайна) | `project`, `seq`, `title`, `state`, `stateGroup`, `priority`, `action`, `entity`, `issueId`, `issueUrl`, `identifier`, `assignee` |
| `plane:<alias>` (результат шага, intake `to: plane:*`) | `issueId`, `issueUrl`, `seq`, `identifier`, `name`, `title`, `description`, `labels`, `workspace`, `project`, `action` |
| `taiga:<alias>` (триггер, первый шаг webhook-пайплайна) | `action`, `entity`, `issueId`, `issueUrl`, `seq`, `identifier`, `name`, `title`, `description`, `project`, `status`, `statusFrom`, `type`, `priority`, `labels`, `assignee`, `assigneeEmail`, `assigneeUsername`, `assigneeInitials`, `slug`, `author`, `changedFields`, `sprint`, `parentId`, `parentSeq`, `parentIdentifier`, `parentName`, `parentUrl`, `receivedAt` |
| `taiga:<alias>` (результат шага, `to: taiga:*`) | `issueId`, `issueUrl`, `seq` (ref), `identifier` (`#ref`), `name`, `title`, `description`, `labels`, `project`, `action`, `status`, `assignee`, `type`, `priority` |
| `gitlab:<alias>` (триггер, первый шаг webhook-пайплайна) | `event`, `action`, `state`, `repo`, `repoUrl`, `branch`, `target`, `mrIid`, `mrUrl`, `mrTitle`, `draft`, `merged`, `labels`, `author`, `authorEmail`, `commits`, `lastCommit`, `sha`, `taskId`, `taskName`, `taskUrl`, `taskIdentifier`, `receivedAt` |
| `gitlab:<alias>` (результат шага, `to: gitlab:*`) | `branch`, `branchUrl`, `ref`, `repo`, `repoUrl`, `mrIid`, `mrUrl`, `mrTitle`, `mrTarget`, `issueIid`, `issueUrl`, `assignee`, `assigneeEmail`, `assigneeInitials`, `taskId`, `taskName`, `taskUrl`, `taskIdentifier`, `taskProject`, `taskStatus` |
| `bitrix:<alias>` (результат шага, `to: bitrix:*`) | `bitrixId`, `status`, `resolution`, `response`, `provider` |
| `pachka:<alias>` | `messageId`, `chatId`, `channel`, `message` |
| `webhook:<alias>` | `channel`, `message` |
| `form:<alias>` (триггер, отправка формы) | `data`, `user`, `userId`, `chatId`, `receivedAt`, `meta` |

> `plane` и `taiga` играют две роли. Когда провайдер — **источник-триггер** (первый шаг, `from: plane:*` / `from: taiga:*` в webhook-пайплайне) — доступны поля события (`state`/`status`, `priority`, `assignee`, `changedFields`...). Когда он **результат шага** (`to: plane:*` / `to: taiga:*` → следующий `from:` того же ref) — доступны поля записанной задачи (`name`, `description`, `labels`...).

> У `gitlab`-шага `issueId`/`issueUrl` относятся к **issue в GitLab**; исходная задача трекера прокидывается как `taskId`, `taskName`, `taskUrl`, `taskIdentifier`, `taskProject` (имя проекта в трекере) и `taskStatus` (её статус на момент события). Внутри своего `content` gitlab-шаг дополнительно видит вычисляемые переменные (`GITLAB_COMPUTED_VARS`): `slug`, `assigneeInitials`, `assignee`, `assigneeEmail`, `repo`, `repoUrl`, `task*`.

Пример с явной декларацией:
```json
{
  "from": "api:intake",
  "to": "plane:dev",
  "on": {
    "content": { "name": "{{body.name}}", ... },
    "outputs": ["issueId", "issueUrl", "seq", "identifier", "name", "description", "labels"]
  }
}
```

Следующий шаг (`from: "plane:dev"`) может использовать только `{{issueId}}`, `{{issueUrl}}`, `{{seq}}` и т.д. — поля из `outputs` первого шага.

### Унифицированный синтаксис `{{path}}`

Все `content` поля (Plane + Notify) используют единый синтаксис с поддержкой вложенных путей:

- `"{{body.name}}"` — whole-value template (возвращает raw значение, включая массивы)
- `"Hello {{body.user.name}}"` — интерполяция с вложенным путём
- `["Support"]` / `"medium"` — литералы (без `{{}}`)
- `["Support", "{{body.section}}", "{{body.labels}}"]` — массив: каждый элемент резолвится, массивы-значения разворачиваются (flatten), пустые/отсутствующие отбрасываются

Пути резолвятся против outputs провайдера, указанного в `from`.

**Условные блоки** (в `message`-шаблонах и в строковых значениях `content`-маппинга): `{{#path=value}}текст{{/path}}` — текст остаётся, только если значение поля равно `value` (сравнение строковое); `{{#path}}текст{{/path}}` — текст остаётся, только если поле присутствует и непустое. Пример — баннер для критичных заявок:

```json
"message": "{{#priority=Критическая}}🚨 **СРОЧНО** 🚨\n{{/priority}}🔔 {{name}} — срочность: {{priority}}"
```

Значение сравнивается с итоговым output-полем (для taiga `priority` — уже после `priorityLabels`).

### PlaneContent — маппинг полей

Для `to: "plane:*"` rules. Обязательно `name`. Поддерживаются: `name`, `description`, `labels`, `priority`.

Пример с ремаппингом:
```json
"content": {
  "name": "{{body.title}}",           // body.title → name
  "description": "{{body.message}}",  // body.message → description
  "labels": ["Support"],              // статический label
  "priority": "medium"                // статический приоритет
}
```

### Request body

Формат определяется маппингом в `on.content` первого шага (api:intake → plane:*). При стандартном маппинге:
- `name` (required) — название задачи
- `description` — HTML-описание
- `labels` — массив текстовых имён labels (резолвятся в UUID)
- `attachments` — файлы (multipart/form-data, вне content-маппинга)

### Плейсхолдеры для intake

| Плейсхолдер | Значение |
|---|---|
| `{{name}}` / `{{title}}` | Название задачи |
| `{{project}}` | Имя проекта (из правила) |
| `{{seq}}` | Номер задачи |
| `{{identifier}}` | Идентификатор (DEV-42) |
| `{{issueId}}` | UUID задачи |
| `{{issueUrl}}` | Ссылка на задачу в Plane |
| `{{labels}}` | Label names через запятую |
| `{{description}}` | Описание |
| `{{action}}` | "created" |

Шаблон по умолчанию: `[{{project}}] Новая заявка: {{name}}`

## Правила генерации

1. `workspace` и `project` — обязательны в каждом правиле
2. Один target может быть и в `webhooks`, и в `pachka.chatIds`. API приоритетнее
3. `actions` работают ТОЛЬКО для targets из `pachka.chatIds`. Для webhook-targets — игнорируются
4. `emoji` в reaction — юникод-символ (`"✅"`, `"🔥"`), не текстовый код (`"white_check_mark"`)
5. Условия в `on` комбинируются через AND. Массивы значений — через OR
6. `stateGroup` полезен когда имена состояний неизвестны, но известна группа
7. Не дублируй правила: `state: "Done"` и `stateGroup: "completed"` пересекаются (Done входит в completed)
8. `editPrevious` пропускается если предыдущего сообщения нет (задача создана до запуска бриджа); если есть — у прошлого сообщения снимаются кнопки-действия, а отслеживание переезжает на новое
9. `threadReply` создаёт тред автоматически, повторные вызовы добавляют сообщения в тот же тред
10. Кнопки `buttons` прикрепляются к основному сообщению, а не добавляются постфактум
11. Шаблон по умолчанию (если `message` не указан): `[{{project}}] #{{seq}} «{{title}}» → {{state}} ({{priority}})`

## Примеры типовых сценариев

### Plane webhook → Pachka (текст через webhook)

```json
{
  "plane": { "baseUrl": "http://plane.example.com" },
  "webhooks": { "chat": "https://api.pachca.com/webhooks/xxx" },
  "rules": [
    {
      "from": "plane", "to": "webhook:chat",
      "workspace": "team", "project": "Backend",
      "on": {
        "action": "update", "state": "Done",
        "content": { "message": "✅ #{{seq}} «{{title}}»" }
      }
    }
  ]
}
```

### Plane webhook → Pachka API (кнопка + реакция)

```json
{
  "plane": { "baseUrl": "http://plane.example.com" },
  "pachka": { "chatIds": { "dev": 12345678 } },
  "rules": [
    {
      "from": "plane", "to": "pachka:dev",
      "workspace": "team", "project": "Backend",
      "on": {
        "action": "update", "state": "Done",
        "content": {
          "message": "✅ #{{seq}} «{{title}}»",
          "actions": [
            { "type": "reaction", "emoji": "✅" },
            { "type": "buttons", "buttons": [{ "text": "Открыть", "url": "{{issueUrl}}" }] }
          ]
        }
      }
    }
  ]
}
```

### Intake pipeline — создание + уведомление

```json
{
  "plane": { "baseUrl": "http://plane.example.com" },
  "pachka": { "chatIds": { "support": 12345678 } },
  "rules": [
    [
      {
        "from": "api:intake", "to": "plane:dev",
        "on": {
          "action": "create", "entity": "task",
          "content": {
            "name": "{{body.name}}",
            "description": "{{body.description}}",
            "labels": "{{body.labels}}"
          }
        }
      },
      {
        "from": "plane:dev", "to": "pachka:support",
        "on": {
          "action": "create", "entity": "task",
          "content": {
            "message": "📬 Новая заявка: {{name}}",
            "actions": [
              { "type": "buttons", "buttons": [{ "text": "Открыть в Plane", "url": "{{issueUrl}}" }] }
            ]
          }
        }
      }
    ]
  ]
}
```

### Intake pipeline — Taiga + уведомление в Пачку

```json
{
  "providers": [
    { "type": "taiga", "alias": "support", "baseUrl": "https://api.taiga.io", "project": "my-project-slug" },
    { "type": "pachka", "alias": "helpdesk", "chatId": 12345678 },
    { "type": "api", "alias": "intake-support", "endpoint": "/api/taiga/intake-support" }
  ],
  "rules": [
    [
      {
        "from": "api:intake-support", "to": "taiga:support",
        "on": {
          "action": "create",
          "content": {
            "name": "{{body.name}}",
            "description": "{{body.description}}",
            "labels": "{{body.labels}}"
          }
        }
      },
      {
        "from": "taiga:support", "to": "pachka:helpdesk",
        "on": {
          "action": "create",
          "content": {
            "message": "📬 Новая заявка: {{name}}",
            "actions": [
              { "type": "buttons", "buttons": [{ "text": "Открыть в Taiga", "url": "{{issueUrl}}" }] }
            ]
          }
        }
      }
    ]
  ]
}
```

### Назначение задачи → ветка + draft MR + ЛС исполнителю

Полная версия с пояснениями — в [docs/configuration.md](docs/configuration.md) («Задача назначена → ветка, draft MR и ЛС исполнителю»).

```json
{
  "providers": [
    { "type": "taiga", "alias": "dev", "baseUrl": "https://tasks.example.com", "project": "dev", "entity": "user_story",
      "feedback": { "statuses": { "accept": "In progress" }, "workEmailField": "Рабочая почта" } },
    { "type": "gitlab", "alias": "backend", "baseUrl": "https://git.example.com", "project": "team/backend", "defaultBranch": "master" },
    { "type": "pachka", "alias": "dev-dm", "dm": true }
  ],
  "rules": [
    [
      {
        "from": "taiga:dev", "to": "gitlab:backend",
        "on": {
          "changed": "assigned_to", "assigned": "first",
          "content": {
            "branch": "feat/{{assigneeInitials}}/{{slug}}",
            "mr": { "title": "{{taskIdentifier}} {{taskName}}", "description": "Задача: {{taskUrl}}" }
          }
        }
      },
      {
        "from": "gitlab:backend", "to": "taiga:dev",
        "on": { "content": { "item": "{{taskId}}", "customFields": { "Gitlab MR": "{{mrUrl}}", "Ветка": "{{branch}}" } } }
      },
      {
        "from": "gitlab:backend", "to": "pachka:dev-dm",
        "on": {
          "once": true,
          "content": {
            "recipient": "{{assigneeEmail}}",
            "message": "🆕 **[{{taskProject}}]** Вам назначена [{{taskIdentifier}} {{taskName}}]({{taskUrl}})\nСтатус: {{taskStatus}}\nВетка: `{{branch}}`",
            "actions": [{ "type": "buttons", "buttons": [
              { "text": "🔀 MR", "url": "{{mrUrl}}" },
              { "text": "👍 Взять в работу", "callbackData": "taiga:dev:accept:{{taskId}}" }
            ]}]
          }
        }
      }
    ],
    [
      {
        "from": "gitlab:backend", "to": "taiga:dev",
        "on": {
          "event": "merge_request", "action": "merge", "target": "master",
          "content": { "item": "{{taskId}}", "status": "Done", "comment": "MR {{mrUrl}} влит в {{target}}" }
        }
      }
    ]
  ]
}
```

### Все задачи истории готовы → user story в тестирование

Передача задачи в тестирование означает «моя часть сделана», а e2e-тестировать user story есть смысл только когда готова последняя её задача. Поэтому задачи переводятся в `Ready for Test` (прогресс виден в Taiga), последняя из них переводит саму историю в `Testing`, и уже это событие уходит карточкой в канал тестировщиков. Нужны два провайдера на один проект: `entity: "task"` и `entity: "user_story"` — у них разные наборы статусов. Полная версия с пояснениями — в [docs/configuration.md](docs/configuration.md).

```json
[
  {
    "from": "taiga:med2", "to": "taiga:med2-us",
    "on": {
      "entity": "task", "changed": "status", "status": "Ready for Test",
      "allTasks": ["Ready for Test", "Done"],
      "content": { "item": "{{parentId}}", "status": "Testing", "comment": "🧪 Все задачи готовы" }
    }
  }
]
```

```json
[
  {
    "from": "taiga:med2-us", "to": "pachka:med2-testing",
    "on": {
      "changed": "status", "status": "Testing",
      "content": {
        "message": "🧪 **Готово к тестированию**\n[{{identifier}} {{name}}]({{issueUrl}})\n🦸‍♂️ {{assignee}} · 📋 {{status}}",
        "actions": [{ "type": "buttons", "buttons": [
          { "text": "🌐 Перейти на сайт", "url": "https://app.example.com" },
          { "text": "↩️ Вернуть в работу", "callbackData": "taiga:med2-us:rework:{{issueId}}" },
          { "text": "✅ Завершить", "callbackData": "taiga:med2-us:close:{{issueId}}" }
        ]}],
        "buttonsByStatus": {
          "Testing": [
            { "text": "↩️ Вернуть в работу", "action": "rework" },
            { "text": "✅ Завершить", "action": "close" }
          ],
          "Done": [{ "text": "↩️ Вернуть в работу", "action": "rework" }]
        }
      }
    }
  }
]
```

Действие возврата названо `rework`, а не `resume`, намеренно: `accept`/`resume` ещё и назначают нажавшего исполнителем, а тестировщик историю не делает.

Третье правило — зеркало роллапа, и без него передача работает один раз: задача, вернувшаяся в работу, снимает историю с тестирования. Пока история висит в `Testing`, повторная сборка задач ничего не меняет, а событие без диффа по статусу карточку не отправляет — тестировщики так и не узнают, что история готова снова. `parentStatus` ограничивает правило именно этим случаем: обычное движение задач внутри ещё не переданной истории её статус не трогает.

```json
[
  {
    "from": "taiga:med2", "to": "taiga:med2-us",
    "on": {
      "entity": "task", "changed": "status",
      "status": ["To do", "In Progress", "Pause", "Review"],
      "parentStatus": "Testing",
      "content": { "item": "{{parentId}}", "status": "In Progress", "comment": "↩️ {{identifier}} снова в работе" }
    }
  }
]
```

### Разные каналы для разных событий

```json
{
  "plane": { "baseUrl": "http://plane.example.com" },
  "webhooks": { "alerts": "https://api.pachca.com/webhooks/xxx" },
  "pachka": { "chatIds": { "dev": 12345678 } },
  "rules": [
    {
      "from": "plane", "to": "pachka:dev",
      "workspace": "team", "project": "Backend",
      "on": {
        "action": "create",
        "content": { "message": "📋 #{{seq}} «{{title}}»" }
      }
    },
    {
      "from": "plane", "to": "webhook:alerts",
      "workspace": "team", "project": "Backend",
      "on": {
        "priority": ["urgent", "high"],
        "content": { "message": "🔥 #{{seq}} «{{title}}» — {{priority}}" }
      }
    },
    {
      "from": "plane", "to": "pachka:dev",
      "workspace": "team", "project": "Backend",
      "on": {
        "action": "update", "stateGroup": "completed",
        "content": {
          "message": "✅ #{{seq}} «{{title}}»",
          "actions": [
            { "type": "reaction", "emoji": "✅" },
            { "type": "threadReply", "message": "Завершена: {{state}}" }
          ]
        }
      }
    }
  ]
}
```
