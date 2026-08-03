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
- `config.ts` — типы конфига (`Config`, `PachkaConfig`), `loadConfig()`, `validateConfig()`
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
- `domain/services/action-executor.ts` — `extractButtons()` (чистая логика)
- `application/ports/messenger-client.port.ts` — интерфейс `IMessengerClient`
- `application/ports/message-store.port.ts` — интерфейс `IMessageStore`
- `application/use-cases/execute-actions.ts` — `executeActions()` (reaction, threadReply, editPrevious)
- `application/use-cases/open-form-view.ts` — `OpenFormViewUseCase` (открытие модальной формы по кнопке)
- `application/use-cases/process-form-submission.ts` — `ProcessFormSubmissionUseCase` (отправка формы → пайплайн)
- `infrastructure/clients/pachka-api-client.ts` — `PachkaClient` (implements `IMessengerClient`)
- `infrastructure/clients/pachka-webhook-sender.ts` — legacy webhook отправка
- `infrastructure/persistence/sqlite-message-store.ts` — `MessageStore` (implements `IMessageStore`)
- `infrastructure/webhooks/pachka-callback.route.ts` — Elysia-plugin: `POST /webhook/pachka`

### Модуль Taiga (`src/modules/taiga/`)

- `application/ports/taiga-api.port.ts` — интерфейс `ITaigaApiClient`
- `application/services/create-taiga-issue.ts` — `createTaigaIssueFromContent()`, `TaigaWriteError` (создание item + сборка outputs)
- `infrastructure/clients/taiga-api-client.ts` — `TaigaApiClient` (адаптер над npm-библиотекой `taiga-api-client`)

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
- `tests/unit/core/` — тесты core (logger)
- `tests/unit/plane/` — тесты plane domain (rule-matcher, template-renderer)
- `tests/unit/messenger/` — тесты messenger (message-store)
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

// Редактирование ранее отправленного сообщения по этой задаче
{ "type": "editPrevious", "message": "Новый текст" }

// Закрепление (зарезервировано)
{ "type": "pin" }
```

## Нотация from/to (pipeline)

Формат: `"<система>:<уточнение>"` — namespace через двоеточие. Все поля обязательны.

### `from` — источник события
| Значение | Описание |
|---|---|
| `"plane"` | Plane (через webhook) |
| `"api:intake"` | API endpoint `/api/plane/intake-issues` |
| `"form:<alias>"` | Отправка формы Пачки (модального представления) провайдера `form:<alias>` |

### `to` — получатель/действие
| Значение | Описание |
|---|---|
| `"plane:<alias>"` | Создать задачу в Plane-провайдере `<alias>` (workspace/project из провайдера). Работает и в intake-, и в webhook-пайплайнах (последнее = mirror/escalate: создать задачу по событию). Использует тот же путь создания, что и intake. |
| `"taiga:<alias>"` | Создать item в Taiga-провайдере `<alias>` (issue / user story / task — тип задаётся полем `entity` провайдера, по умолчанию `issue`). Работает и в intake-, и в webhook-пайплайнах. Attachments не поддерживаются. |
| `"pachka:<channel>"` | Уведомить в Пачку, channel = alias `pachka`-провайдера |
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
4. После перехода кнопки сообщения заменяются набором из `feedback.buttons` для нового статуса; статус ищется среди статусов проекта по имени.
5. Имена действий свободные — семантика фиксирована только для `accept`/`resume` (назначение исполнителя), остальные просто меняют статус.
6. `feedback.statusLabels` — отображаемые имена статусов для сообщений (`"In progress": "В процессе 🚀"`).
7. Outputs taiga-шага включают `status` (label), `assignee`, `type` (тип issue из Taiga: «Ошибка», «Вопрос»...) — можно использовать в шаблоне уведомления для «живой карточки».
8. При переходе статуса (клик по кнопке или вебхук Taiga) текст сообщения **перерисовывается** по шаблону `content.message` того же правила `taiga:<alias> → pachka:<target>` со свежими `{{status}}`/`{{assignee}}`/`{{type}}`; если шаблон не найден — текст сохраняется, меняются только кнопки.

### Вебхук Taiga → синхронизация кнопок

`POST /webhook/taiga` принимает вебхуки Taiga (`src/modules/taiga/infrastructure/webhooks/taiga-webhook.route.ts`). При смене статуса item'а в самой Taiga (вручную или после нажатия кнопки) кнопки отслеживаемого сообщения в Пачке заменяются набором из `feedback.buttons` для нового статуса — кнопки не расходятся с реальным состоянием (`ProcessTaigaWebhookUseCase`).

Настройка вебхука в Taiga (Settings → Integrations → Webhooks):
- **URL**: `https://<хост-сервиса>/webhook/taiga`
- **Secret key**: произвольная строка; та же строка должна быть в env `TAIGA_WEBHOOK_SECRET`. Подпись — HMAC-SHA1 от raw body в заголовке `X-TAIGA-WEBHOOK-SIGNATURE`; при пустом `TAIGA_WEBHOOK_SECRET` подпись не проверяется.

Провайдер события определяется по slug проекта из `data.project.permalink`; тестовый пинг Taiga (`action: "test"`) отвечает `200 ok`.

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
| `taiga:<alias>` (результат шага, `to: taiga:*`) | `issueId`, `issueUrl`, `seq` (ref), `identifier` (`#ref`), `name`, `title`, `description`, `labels`, `project`, `action`, `status`, `assignee`, `type`, `priority` |
| `pachka:<alias>` | `messageId`, `chatId`, `channel`, `message` |
| `webhook:<alias>` | `channel`, `message` |
| `form:<alias>` (триггер, отправка формы) | `data`, `user`, `userId`, `chatId`, `receivedAt`, `meta` |

> `plane` играет две роли. Когда он **источник-триггер** (первый шаг, `from: plane:*` в webhook-пайплайне) — доступны поля события (`state`, `priority`, `assignee`...). Когда он **результат шага** (intake: `to: plane:*` → следующий `from: plane:*`) — доступны поля созданной задачи (`name`, `description`, `labels`...).

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
8. `editPrevious` пропускается если предыдущего сообщения нет (задача создана до запуска бриджа)
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
