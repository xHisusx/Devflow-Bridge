# Конфигурация

Всё поведение сервиса описывается декларативно в одном JSON-файле: **провайдеры** (подключения к системам) и **пайплайны правил** (что делать с событиями). Секреты в конфиге не хранятся — они резолвятся из переменных окружения.

## Где лежит конфиг

Файл ищется в порядке:

1. `CONFIG_PATH` (переменная окружения)
2. `config/default.json` — рекомендуемое рабочее расположение
3. `config.json` в корне (legacy)

Папка `config/` не попадает в git (см. `.gitignore`); в Docker монтируется томом `./config:/app/config:ro`.

## Структура

```jsonc
{
  "providers": [ /* подключения: plane, taiga, pachka, webhook, api, form */ ],
  "rules":     [ /* массив пайплайнов; пайплайн = массив шагов from → to */ ]
}
```

---

## Провайдеры

Каждый провайдер имеет `type` и `alias`; на него ссылаются по `"<type>:<alias>"` (например, `plane:dev`).

### `plane` — инстанс Plane

```jsonc
{
  "type": "plane",
  "alias": "dev",
  "baseUrl": "https://plane.example.com",
  "workspace": "my-team",     // slug воркспейса
  "project": "Backend"        // имя проекта
}
```

API-ключ резолвится из env: `PLANE_API_KEY_<ALIAS>` (alias в верхнем регистре, не-буквенно-цифровые символы → `_`), с откатом на общий `PLANE_API_KEY`. Это позволяет подключать несколько Plane-инстансов с разной авторизацией. Нет ключа — старт падает с ошибкой.

### `taiga` — проект Taiga

```jsonc
{
  "type": "taiga",
  "alias": "support",
  "baseUrl": "https://api.taiga.io",   // корень инстанса (без /api/v1)
  "project": "my-project-slug",
  "webUrl": "https://tree.taiga.io",   // опционально: корень web-UI для ссылок (default: baseUrl)
  "entity": "issue",                   // "issue" | "user_story" | "task" (default: "issue")
  "priorityLabels": {                  // опционально: имя приоритета Taiga → отображение в сообщениях
    "Normal": "Обычная",
    "Critical": "Критическая"
  },
  "feedback": { /* см. «Обратная связь Пачка → Taiga» */ }
}
```

Креды из env: `TAIGA_APP_TOKEN_<ALIAS>` (application token) либо `TAIGA_USERNAME_<ALIAS>` + `TAIGA_PASSWORD_<ALIAS>`, с откатом на общие `TAIGA_APP_TOKEN` / `TAIGA_USERNAME` / `TAIGA_PASSWORD`. Нет кредов — старт падает.

### `pachka` — чат Пачки (API-режим)

```jsonc
{ "type": "pachka", "alias": "helpdesk", "chatId": 12345678 }
```

Требует `PACHKA_API_TOKEN`. Даёт кнопки, реакции, треды, редактирование сообщений.

### `webhook` — incoming webhook Пачки (только текст)

```jsonc
{ "type": "webhook", "alias": "alerts", "url": "https://api.pachca.com/webhooks/xxx" }
```

Работает без API-токена, но `actions` для webhook-целей игнорируются.

### `api` — HTTP intake-эндпоинт

```jsonc
{ "type": "api", "alias": "intake", "endpoint": "/api/plane/intake-issues" }
```

Монтирует `POST <endpoint>`; запрос запускает пайплайн, чей первый шаг — `from: "api:<alias>"`. Эндпоинтов может быть несколько — по одному на провайдера.

**Авторизация:** ключ из env `INTAKE_API_KEY_<ALIAS>` с откатом на `INTAKE_API_KEY`; нет ключа — старт падает. Клиент передаёт ключ в `Authorization: Bearer <key>` либо `X-API-Key: <key>`; неверный ключ → `401`. Сравнение — константное по времени. Провайдер может отключить проверку полем `"auth": false` (эндпоинт публичный, в лог пишется warning).

**Валидация тела (`fields`):** декларативная схема полей body — проверяется до запуска пайплайна, ошибка → `400 {"ok":false,"error":"..."}` с перечислением проблем:

```jsonc
{
  "type": "api", "alias": "intake", "endpoint": "/api/taiga/intake",
  "fields": {
    "section": {
      "required": true,                          // отсутствует/пустая строка → 400
      "values": ["Реестр контрактов", "KPI"]     // значение вне списка → 400 (сравнение строгое, с учётом регистра)
    },
    "discoveredAt": {
      "requiredIf": { "field": "type", "value": "Ошибка" }  // обязательно, только если body.type == "Ошибка"
    }
  }
}
```

### `form` — модальная форма Пачки

```jsonc
{ "type": "form", "alias": "support-request", "file": "forms/support-request.json" }
```

Определение формы — в отдельном файле (путь относительно директории конфига) либо inline через `title` / `submitText` / `closeText` / `blocks`. Inline-поля имеют приоритет над файлом. Отсутствующий файл или форма без `blocks` — ошибка старта. Подробнее — в разделе «Формы Пачки».

---

## Пайплайны правил

`rules` — массив пайплайнов (`Rule[][]`). Пайплайн = массив шагов, выполняемых последовательно с передачей данных. Каждый шаг:

```jsonc
{
  "from": "plane:dev",        // источник данных шага
  "to": "pachka:helpdesk",    // получатель/действие
  "on": {
    // условия срабатывания (только для Plane-триггера, первый шаг):
    "action": "update",              // create | update | delete
    "entity": "issue",               // issue | work_item | ...
    "state": "Done",                 // string | string[]
    "stateGroup": "completed",       // backlog | unstarted | started | completed | cancelled
    "priority": ["urgent", "high"],

    // payload шага (обязателен):
    "content": { /* зависит от типа to, см. ниже */ },

    // опционально: какие поля шаг экспонирует следующим шагам
    "outputs": ["issueId", "issueUrl", "name"]
  }
}
```

Условия комбинируются через AND, массивы значений — через OR.

### Первый шаг — триггер

| `from` | Триггер |
|---|---|
| `plane:<alias>` | Вебхук Plane (`POST /webhook/plane`) |
| `api:<alias>` | HTTP-запрос на intake-эндпоинт провайдера |
| `form:<alias>` | Отправка формы Пачки |

### `to` — получатель шага

| `to` | Действие |
|---|---|
| `plane:<alias>` | Создать задачу в Plane (workspace/project — из провайдера) |
| `taiga:<alias>` | Создать item в Taiga (тип — из поля `entity` провайдера) |
| `pachka:<alias>` | Отправить сообщение в чат Пачки через API |
| `webhook:<alias>` | Отправить текст через incoming webhook |

`plane:*`/`taiga:*` как цель работают и в intake-, и в webhook-пайплайнах (последнее = mirror/escalate: создать задачу по событию).

### `content` — типизирован по цели

**Для `to: plane:*` / `to: taiga:*`** — маппинг полей создаваемой задачи (обязательно `name`; поддерживаются `name`, `description`, `labels`, `priority`, для Taiga также `type`):

```json
"content": {
  "name": "{{body.name}}",
  "description": "{{body.description}}",
  "labels": ["Support"],
  "priority": "medium"
}
```

Особенности Taiga: `labels` маппится в tags (создаются на лету); `type` и `priority` (только для `entity: "issue"`) резолвятся по имени из справочников проекта без учёта регистра, неизвестное значение — ошибка 400 со списком доступных.

**Для `to: pachka:*` / `to: webhook:*`** — шаблон уведомления:

```json
"content": {
  "message": "📬 {{name}} → {{state}}",
  "actions": [
    { "type": "buttons", "buttons": [{ "text": "Открыть", "url": "{{issueUrl}}" }] }
  ]
}
```

### Типы `actions`

Работают только для `pachka:*`-целей (API-режим); для `webhook:*` игнорируются.

```jsonc
{ "type": "reaction", "emoji": "✅" }                 // юникод-символ, НЕ текстовый код
{ "type": "threadReply", "message": "{{state}}" }     // ответ в тред (создаётся автоматически)
{ "type": "editPrevious", "message": "Новый текст" }  // редактирование прошлого сообщения по задаче
{ "type": "buttons", "buttons": [
  { "text": "Открыть", "url": "{{issueUrl}}" },                  // кнопка-ссылка
  { "text": "Взять", "callbackData": "taiga:support:accept:{{issueId}}" },  // интерактивная
  { "text": "📝 Заявка", "form": "support-request" }             // открывает форму
]}
{ "type": "pin" }                                     // зарезервировано
```

Поля `url` / `callbackData` / `form` в кнопке взаимоисключимы. `editPrevious` пропускается, если предыдущего сообщения нет.

---

## Шаблоны `{{path}}`

Все поля `content` используют единый синтаксис с вложенными путями:

- `"{{body.name}}"` — whole-value шаблон (возвращает raw-значение, включая массивы)
- `"Hello {{body.user.name}}"` — интерполяция
- `["Support"]` / `"medium"` — литералы (без `{{}}`)
- `["Support", "{{body.section}}", "{{body.labels}}"]` — массив: каждый элемент резолвится, массивы-значения разворачиваются (flatten), пустые/отсутствующие отбрасываются

Пути резолвятся против outputs провайдера из `from`.

**Условные блоки** (в `message`-шаблонах и в строковых значениях `content`-маппинга): `{{#path=value}}текст{{/path}}` — текст остаётся, только если значение поля равно `value` (строковое сравнение); `{{#path}}текст{{/path}}` — только если поле присутствует и непустое:

```json
"message": "{{#priority=Критическая}}🚨 **СРОЧНО** 🚨\n{{/priority}}🔔 {{name}} — срочность: {{priority}}"
```

### Outputs — что видит следующий шаг

Каждый шаг может декларировать `on.outputs` — список полей, которые он экспонирует дальше. Без `outputs` экспонируется полная схема провайдера. Валидация строгая: если следующий шаг использует `{{x}}`, а `x` не экспонирован — warning при старте.

| Провайдер (роль) | Exposed fields |
|---|---|
| `api:*` (триггер) | `body`, `files`, `receivedAt` |
| `plane:*` (триггер webhook-пайплайна) | `project`, `seq`, `title`, `state`, `stateGroup`, `priority`, `action`, `entity`, `issueId`, `issueUrl`, `identifier`, `assignee` |
| `plane:*` (результат шага `to: plane:*`) | `issueId`, `issueUrl`, `seq`, `identifier`, `name`, `title`, `description`, `labels`, `workspace`, `project`, `action` |
| `taiga:*` (результат шага `to: taiga:*`) | `issueId`, `issueUrl`, `seq`, `identifier`, `name`, `title`, `description`, `labels`, `project`, `action`, `status`, `assignee`, `type`, `priority` |
| `pachka:*` | `messageId`, `chatId`, `channel`, `message` |
| `webhook:*` | `channel`, `message` |
| `form:*` (триггер) | `data`, `user`, `userId`, `chatId`, `receivedAt`, `meta` |

> `plane` играет две роли: как **триггер** (первый шаг) даёт поля события, как **результат шага** — поля созданной задачи.

Шаблон уведомления по умолчанию (если `message` не указан): `[{{project}}] #{{seq}} «{{title}}» → {{state}} ({{priority}})`.

---

## Intake-эндпоинты

Формат тела запроса определяется маппингом `on.content` первого шага. При стандартном маппинге:

- `name` (required) — название задачи
- `description` — HTML-описание
- `labels` — массив имён меток (резолвятся в UUID; в Taiga — теги)
- `attachments` — файлы (только `multipart/form-data`, вне content-маппинга; изображения встраиваются в описание, остальные — attachments; Taiga attachments не поддерживает)

```bash
curl -X POST https://bridge.example.com/api/plane/intake-issues \
  -H "Authorization: Bearer $INTAKE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Новый баг", "description": "<p>Детали</p>", "labels": ["bug"]}'
```

Формальное описание HTTP API — в [openapi.yaml](openapi.yaml).

---

## Формы Пачки (модальные представления)

Кнопка в сообщении бота открывает [форму Пачки](https://dev.pachca.com/guides/forms/overview); отправка формы запускает пайплайн. Требуется `PACHKA_API_TOKEN` со скоупом `views:write`; исходящий вебхук Пачки должен указывать на `POST /webhook/pachka`.

Файл формы — нативный формат Пачки (snake_case, pass-through в `POST /views/open`):

```jsonc
// config/forms/support-request.json
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

Кнопка открытия — поле `form` в кнопке notify-шага:

```json
{ "type": "buttons", "buttons": [{ "text": "📝 Заполнить заявку", "form": "support-request" }] }
```

Пайплайн с первым шагом `from: "form:<alias>"` получает outputs:

| Поле | Значение |
|---|---|
| `{{data.<name>}}` | Значения полей формы по `name` блока; file_input нормализуется в строку markdown-ссылок (URL действительны 1 час) |
| `{{user}}` / `{{user.first_name}}` | Профиль отправителя (best-effort, может быть null) |
| `{{userId}}` / `{{chatId}}` | ID пользователя и чата |
| `{{receivedAt}}` | Время отправки («11.07.2026 08:03») |
| `{{meta.*}}` | Корреляция: `formRef`, `messageId`, `chatId`, `correlationId`, `target` |

Механика: клик → вебхук с `trigger_id` (TTL 3 сек) → синхронный `POST /views/open`. Отправка формы → мгновенный `200` (закрывает модалку), пайплайн выполняется асинхронно. Валидацию required/min/max выполняет сама Пачка. Ограничения: без prefill в `initial_value`, файлы не скачиваются (только ссылки), кастомная серверная валидация не поддерживается.

Публикация кнопки формы в чат (например, закреплённое сообщение «Создать заявку»):

```bash
bun run scripts/post-form-button.ts <form-alias> <pachka-alias|chatId> [message] [button-text]
```

⚠️ Если пайплайн формы ведёт в `to: taiga:*` с маппингом `type`, значения `value` select-опций должны совпадать с именами типов запроса в проекте Taiga (без учёта регистра) — иначе создание item упадёт с «Issue type not found» (форма закроется, ошибка останется в логах).

---

## Обратная связь Пачка → Taiga (feedback)

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
  "statusLabels": { "In progress": "В процессе 🚀" },  // отображаемые имена статусов
  "workEmailField": "Рабочая почта"  // кастомное поле профиля Пачки с рабочей почтой
}
```

Механика:

1. Стартовая кнопка в notify-шаге: `{ "text": "👍 Взять в работу", "callbackData": "taiga:<alias>:accept:{{issueId}}" }`. Формат: `taiga:<alias>:<action>:<itemId>`.
2. Нажатие прилетает в `POST /webhook/pachka` (исходящий вебхук Пачки должен указывать на этот роут).
3. `accept` и `resume` дополнительно назначают исполнителя: у нажавшего берётся email из поля `workEmailField` (fallback — email профиля), участник проекта Taiga ищется по email.
4. После перехода кнопки заменяются набором из `feedback.buttons` для нового статуса.
5. Имена действий свободные — семантика фиксирована только для `accept`/`resume`.
6. Outputs taiga-шага включают `status` (label), `assignee`, `type`, `priority` — можно строить «живую карточку»: при смене статуса текст сообщения перерисовывается по шаблону `content.message` правила `taiga:<alias> → pachka:<target>` со свежими значениями.

### Вебхук Taiga → синхронизация кнопок

`POST /webhook/taiga` принимает вебхуки Taiga. При смене статуса item'а в самой Taiga кнопки отслеживаемого сообщения в Пачке обновляются — не расходятся с реальным состоянием.

Настройка в Taiga (Settings → Integrations → Webhooks):
- **URL**: `https://<хост-сервиса>/webhook/taiga`
- **Secret key**: произвольная строка; та же строка — в env `TAIGA_WEBHOOK_SECRET`. Подпись — HMAC-SHA1 от raw body в `X-TAIGA-WEBHOOK-SIGNATURE`; при пустом секрете подпись не проверяется.

Провайдер определяется по slug проекта из `data.project.permalink`; тестовый пинг Taiga (`action: "test"`) отвечает `200 ok`.

---

## Настройка вебхука Plane

1. **Workspace Settings → Webhooks → Create Webhook**
2. URL: `https://<хост-сервиса>/webhook/plane`
3. Подписаться на нужные события (минимум — Issues)
4. Сгенерированный секрет — в `PLANE_WEBHOOK_SECRET` (проверка HMAC-SHA256 подписи `X-Plane-Signature`; без секрета запросы принимаются без проверки)

Дубликаты вебхуков отфильтровываются автоматически (дедупликация по issue + action + state, окно ~10 сек).

---

## Переменные окружения

| Переменная | Обязательная | Описание |
|---|---|---|
| `CONFIG_PATH` | нет | Путь к конфигу (default: `config/default.json` → `config.json`) |
| `PLANE_API_KEY` / `PLANE_API_KEY_<ALIAS>` | при plane-провайдерах | API-ключ Plane (общий / per-alias) |
| `PLANE_WEBHOOK_SECRET` | нет | Секрет вебхука Plane (HMAC-SHA256) |
| `PACHKA_API_TOKEN` | для API-режима | Токен бота Пачки (кнопки, реакции, треды, формы) |
| `TAIGA_APP_TOKEN[_<ALIAS>]` | при taiga-провайдерах* | Application token Taiga |
| `TAIGA_USERNAME[_<ALIAS>]` + `TAIGA_PASSWORD[_<ALIAS>]` | при taiga-провайдерах* | Логин/пароль Taiga (альтернатива токену) |
| `TAIGA_WEBHOOK_SECRET` | нет | Секрет вебхука Taiga (HMAC-SHA1) |
| `INTAKE_API_KEY` / `INTAKE_API_KEY_<ALIAS>` | при api-провайдерах | Ключ intake-эндпоинта (кроме `"auth": false`) |
| `MESSAGE_DB_PATH` | нет | Путь к SQLite (default: `data/messages.sqlite`) |
| `PORT` | нет | Порт HTTP-сервера (default: `3000`) |
| `LOG_LEVEL` | нет | `debug` \| `info` \| `warn` \| `error` (default: `info`) |

\* достаточно одного из вариантов. Схема резолва per-alias везде одинаковая: alias в верхнем регистре, не-буквенно-цифровые символы → `_`, откат на переменную без суффикса.

---

## Полный пример: форма → задача → уведомление

```json
{
  "providers": [
    { "type": "plane", "alias": "dev", "baseUrl": "https://plane.example.com", "workspace": "team", "project": "Backend" },
    { "type": "pachka", "alias": "support", "chatId": 12345678 },
    { "type": "form", "alias": "support-request", "file": "forms/support-request.json" }
  ],
  "rules": [
    [
      {
        "from": "form:support-request", "to": "plane:dev",
        "on": {
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
          "content": {
            "message": "📬 Заявка из формы: {{name}}",
            "actions": [
              { "type": "buttons", "buttons": [{ "text": "Открыть", "url": "{{issueUrl}}" }] }
            ]
          }
        }
      }
    ]
  ]
}
```

Больше сценариев (webhook-уведомления, intake API, Taiga с feedback-циклом) — в примерах README и в [CLAUDE.md](../CLAUDE.md).

## Правила и подводные камни

1. При старте конфиг валидируется: ссылки на провайдеров, шаблоны против outputs, структура форм — проблемы пишутся warning'ами в лог.
2. `emoji` в reaction — юникод-символ (`"✅"`), не текстовый код (`"white_check_mark"`).
3. Не дублируйте условия: `state: "Done"` и `stateGroup: "completed"` пересекаются.
4. `stateGroup` полезен, когда имена состояний неизвестны, но известна группа.
5. Кнопки `buttons` прикрепляются к основному сообщению, а не добавляются постфактум.
6. Формы могут быть только источником пайплайна (`from`), не целью.
