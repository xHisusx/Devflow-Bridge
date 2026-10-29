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

### `gitlab` — репозиторий GitLab (self-hosted или SaaS)

```jsonc
{
  "type": "gitlab",
  "alias": "backend",
  "baseUrl": "https://git.example.com",   // корень инстанса (/api/v4 добавляется сам)
  "project": "team/backend",              // репозиторий по умолчанию: path или numeric id
  "repoByTag": {                          // опционально: тег задачи → репозиторий
    "backend": "team/api",
    "frontend": "team/web"
  },
  "defaultBranch": "master",              // база новых ветвей и target MR (default: "master")
  "branch": {
    "pattern": "{{branchType}}/{{assigneeInitials}}/{{slug}}",  // default именно такой
    "maxSlugLength": 60,
    "type": "feat",                       // тип ветки, когда ни один тег не подошёл
    "typeByTag": {                        // тег задачи (или имя типа issue) → тип ветки
      "баг": "fix", "Bug": "fix", "хотфикс": "hotfix", "рефакторинг": "refactor"
    }
  },
  "mr": {                                 // дефолты для MR, переопределяются в правиле
    "draft": true,                        // default: true
    "target": "master",
    "title": "{{taskIdentifier}} {{taskName}}",
    "description": "Задача: {{taskUrl}}",
    "labels": ["from-taiga"],
    "removeSourceBranch": true,
    "squash": false
  },
  "groups": ["team"],                     // опционально: группы, среди участников которых искать людей
  "userMap": {                            // опционально: email → идентичность в GitLab
    "a.makhov@example.com": { "username": "amakhov", "initials": "am" }
  }
}
```

Токен из env: `GITLAB_TOKEN_<ALIAS>` с откатом на `GITLAB_TOKEN`; нет токена — старт падает. При старте бридж пробует прочитать `GET /user`, чтобы записать в лог, под кем работает; если токену это не разрешено (бывает у group/project access token), в лог идёт warning — старт продолжается.

**Какой токен нужен.** Админский PAT не обязателен:

| Токен | Чего хватает | Чего нет |
|---|---|---|
| **Group access token** (группа → Settings → Access tokens, создаёт Owner), роль **Developer**, скоуп `api` | ветки, MR, issues, комментарии, чтение коммитов и участников во всех проектах группы | поиск по приватному email — вместо него `groups` / `userMap` |
| **Project access token**, роль Developer, скоуп `api` | то же в одном репозитории | то же |
| **PAT бот-аккаунта** со скоупом `api`, добавленного в группу как Developer | то же | то же |
| **PAT администратора**, скоуп `api` | всё, включая поиск людей по приватному email | — |

Group access token на self-managed доступен в любой редакции (на GitLab.com — Premium/Ultimate). Роли Developer хватает, чтобы создать ветку от защищённого `master` (защищён target, а не новая ветка); если wildcard-правила защищают и `feat/*`, нужен Maintainer.

**Как находится исполнитель** — по порядку, до первого попадания:

1. `userMap` — явное соответствие email → `username` / `userId` (работает с любым токеном);
2. `GET /users?search=<email>` — находит публичный email, приватный — только админским токеном;
3. участники групп из `groups` (а если `groups` не задан — участники самого репозитория): сверка по email (если инстанс его отдаёт), затем по username, собранному из локальной части email (`a.makhov@…` → `a.makhov`, `amakhov`, `a_makhov`, `a-makhov`), затем по имени — транслитерация с огрублением, так что «Алексей Махов» = «Alexey Makhov» = «Aleksey Mahov»; если под имя подходит несколько человек, исполнитель не выбирается;
4. `GET /users?username=<кандидат>` для тех же кандидатов.

Если не найден никто, MR создаётся **без исполнителя**, в лог пишется warning, а инициалы для ветки берутся из имени исполнителя в задаче. Индекс участников кешируется на 10 минут.

**Про имя ветки.** `{{branchType}}/{{assigneeInitials}}/{{slug}}`:

- `{{branchType}}` — `branch.typeByTag` по тегам задачи (в их порядке), затем по имени типа задачи (`Bug` → `fix`, так что issue не нужно тегировать), затем `branch.type`, иначе `feat`. Можно переопределить в правиле полем `branchType`.
- `{{assigneeInitials}}` — первая буква имени + первая буква фамилии исполнителя («Данила Коновницын» → `dk`); можно задать явно в `userMap`.
- `{{slug}}` — название задачи латиницей, обрезается по `branch.maxSlugLength` (по словам, не посреди слова).

**Про draft.** В GitLab API нет флага `draft` при создании MR — черновик задаётся префиксом `Draft: ` в заголовке. Бридж добавляет его сам при `"draft": true` (и убирает при `false`).

**Идемпотентность.** Если ветка уже существует, она переиспользуется; если по ней уже открыт MR — он переиспользуется вместо создания второго. Повторная доставка того же события не создаёт дубликатов в репозитории; чтобы не повторилось **уведомление**, поставьте на notify-шаг [`once`](#once--шаг-только-один-раз).

### `pachka` — чат Пачки (API-режим)

```jsonc
{ "type": "pachka", "alias": "helpdesk", "chatId": 12345678 }
```

Требует `PACHKA_API_TOKEN`. Даёт кнопки, реакции, треды, редактирование сообщений.

**Личные сообщения (`dm`)** — провайдер без `chatId`, получатель задаётся шаблоном в шаге:

```jsonc
{
  "type": "pachka",
  "alias": "dev-dm",
  "dm": true,
  "workEmailField": "Рабочая почта"   // кастомное поле профиля с рабочей почтой (default такой же)
}
```

В шаге появляется поле `content.recipient` — рабочая почта или числовой id пользователя Пачки:

```json
{ "from": "gitlab:backend", "to": "pachka:dev-dm",
  "on": { "content": { "recipient": "{{assigneeEmail}}", "message": "🆕 На вас задача…" } } }
```

Email → пользователь ищется так: `GET /users?query=<email>` (совпадение по email профиля), затем полный список сотрудников со сверкой кастомного поля `workEmailField`. Список кешируется на 10 минут. Нужен скоуп `users:read`; личный чат бота с человеком Пачка создаёт сама. Если получатель не найден — шаг пропускается с warning (сообщение не уходит «куда попало»).

### `webhook` — incoming webhook Пачки (только текст)

```jsonc
{ "type": "webhook", "alias": "alerts", "url": "https://api.pachca.com/webhooks/xxx" }
```

Работает без API-токена, но `actions` для webhook-целей игнорируются.

### `bitrix` — обращения Bitrix

```jsonc
{
  "type": "bitrix",
  "alias": "support",
  "baseUrl": "https://portal.example.com/api/v1"   // корень API, без пути /support/appeal/status/
}
```

Токен из env: `BITRIX_API_TOKEN_<ALIAS>` с откатом на `BITRIX_API_TOKEN` (схема как у Plane/Taiga/GitLab); нет токена — старт падает.

Провайдер умеет одно: **проставить статус обращения** (`PUT /support/appeal/status/`). Это обратная сторона intake-потока «заявка из Bitrix → задача в трекере»: когда задачу закрывают в Taiga, обращение в Bitrix закрывается вместе с ней.

Номер обращения не передаётся отдельным полем — он берётся из описания задачи, куда его записал intake-шаг (`**BitrixID:** 12345`; распознаётся и `BitrixID: 12345`, и `**Bitrix ID:** 12345`). Задача без BitrixID — не ошибка: шаг пропускается с warning, потому что не каждая заявка приходит из Bitrix.

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
| `taiga:<alias>` | Вебхук Taiga (`POST /webhook/taiga`) — событие item'а: создание, назначение, смена статуса |
| `gitlab:<alias>` | Вебхук GitLab (`POST /webhook/gitlab`) — событие репозитория: MR открыт / смержен / закрыт, push |
| `api:<alias>` | HTTP-запрос на intake-эндпоинт провайдера |
| `form:<alias>` | Отправка формы Пачки |

Условия Taiga-триггера (дополнительно к `action` / `entity` / `priority`):

```jsonc
"on": {
  "action": "change",         // create | change (синоним update) | close | delete
  "entity": "user_story",     // issue | user_story | task; без него берётся entity провайдера
  "status": "In progress",    // имя статуса после события (string | string[], без учёта регистра)
  "type": "Ошибка",           // тип запроса (только issue)
  "changed": "assigned_to",   // поле изменилось в этом событии (string | string[] = OR)
  "tags": ["фронт", "бэк"],   // у item'а есть хотя бы один из тегов (string | string[], без учёта регистра)
  "assigned": "first",        // "first" — появился первый исполнитель | "any" | "none"
  "sprint": "any",            // "any" — задача в спринте | "none" | имя спринта (string | string[])
  "allTasks": "Ready for Test" // все задачи user story в одном из этих статусов (string | string[])
}
```

`assigned: "first"` срабатывает и когда задачу создали сразу с исполнителем, и когда исполнитель сменился с пустого на кого-то; переназначение (A → B) под условие **не** попадает. На событии `create` диффа нет, поэтому `changed` с ним не сочетается.

Закрытие item'а Taiga присылает отдельным событием `close` — и **без** `change.diff`, поэтому `changed` с ним тоже не сочетается, а `action: "change"` его не ловит: условие нужно писать как `"action": "close"` и отбирать по `status`.

`tags` — воротами по тегам пайплайн ограничивается задачами, которые его касаются. Типичный случай: ветку и MR нужно заводить только под «кодовые» задачи, а дизайн, аналитика и QA живут в том же спринте и трогать их не нужно. Теги те же, по которым `repoByTag` выбирает репозиторий, поэтому держите оба списка согласованными: задача с тегом не из списка просто не запустит пайплайн (ничего не создастся и в лог попадёт только отсутствие срабатывания).

`sprint` смотрит на спринт (milestone) item'а, а у **task** — на спринт родительской user story: Taiga присылает её внутри payload'а задачи целиком, так что дополнительного запроса к API не нужно. Отсюда же берутся outputs `parentId`, `parentIdentifier`, `parentName`, `parentUrl` — для task это user story, для остальных сущностей они пустые.

`allTasks` отличает «готов кусок» от «готова работа целиком»: условие проходит, когда **все** задачи user story события лежат в перечисленных статусах (у task спрашивается про родительскую историю, у user story — про саму себя). История без задач не проходит никогда — судить не о чем. Перечисляйте все статусы, которые для задачи означают «сделано»: если какую-то задачу уже закрыли в `Done`, а в списке только `Ready for Test`, история не соберётся никогда.

Это единственное условие, которое нельзя вычислить из самого события: оно про *соседние* задачи, поэтому стоит один запрос к API. Проверяется последним — только после того, как сошлись остальные условия.

Условия GitLab-триггера:

```jsonc
"on": {
  "event": "merge_request",   // merge_request | push | tag_push | issue | note | pipeline
  "action": "merge",          // MR: open | close | reopen | update | approved | merge; push: "push"
  "state": "merged",          // opened | closed | merged | locked
  "target": "master",         // target-ветка MR (string | string[] = OR)
  "branch": "feat/am/fix",    // source-ветка MR либо ветка, в которую был push
  "draft": false,             // состояние черновика
  "labels": ["backend"]       // любая из меток MR
}
```

Задача трекера, к которой относится событие, подставляется из **связи ветка/MR → item**, записанной шагом `to: gitlab:*` (`{{taskId}}`, `{{taskUrl}}`, `{{taskIdentifier}}`, `{{taskName}}`) — в вебхуках GitLab никакого id задачи нет. Связь лежит в SQLite (`PIPELINE_DB_PATH`) и ищется сначала по MR, потом по имени ветки, так что MR, созданный на ветке бриджа руками, тоже находится. Если связи нет, `task*` пустые: шаг `to: taiga:*` с `item: "{{taskId}}"` будет пропущен с warning, а уведомления уйдут.

#### Настройка вебхука GitLab

**Settings → Webhooks** в проекте (или в группе — Premium/Ultimate):

- **URL**: `https://<хост-сервиса>/webhook/gitlab`
- **Secret token**: та же строка, что в env `GITLAB_WEBHOOK_SECRET` (или `GITLAB_WEBHOOK_SECRET_<ALIAS>`)
- **Triggers**: *Merge request events* (и *Push events*, если нужны пайплайны по пушу)

GitLab присылает секрет как есть в заголовке `X-Gitlab-Token` (подписи у него нет, в отличие от Plane и Taiga), сравнение — константное по времени. Если ни одного секрета в env нет, проверка отключена и при старте пишется warning. Событие попадает в провайдера, который «отвечает» за репозиторий: `project`, любой репозиторий из `repoByTag` или всё внутри `groups`.

Куда вешать хук — три варианта:

| Где | Редакция | Охват |
|---|---|---|
| Проект: **Settings → Webhooks** | любая | один репозиторий, свой секрет (можно задать одинаковый во всех) |
| Группа: **Settings → Webhooks** | Premium/Ultimate | все репозитории группы, один секрет |
| Инстанс: **Admin Area → System Hooks** | любая, нужны права админа | **весь инстанс**, один секрет |

System hook — способ получить «глобальный секрет» без платной лицензии: один хук, один `GITLAB_WEBHOOK_SECRET`, новые репозитории подключать не нужно. Включите триггер *Merge request events*; payload `merge_request` у системного хука такой же, как у проектного (верхнеуровневый `project.path_with_namespace`), а секрет уходит в том же `X-Gitlab-Token`. Платой за это идёт поток чужих событий: системный хук шлёт и MR других команд, и инстансные события (`user_create`, `project_create`, …). Бридж их отбрасывает — события без `object_kind` игнорируются, остальные отсекает проверка репозитория, — но весь этот трафик будет приходить на `/webhook/gitlab`, учитывайте это при публикации эндпоинта наружу.

### `to` — получатель шага

| `to` | Действие |
|---|---|
| `plane:<alias>` | Создать задачу в Plane (workspace/project — из провайдера) |
| `taiga:<alias>` | Создать item в Taiga, либо **обновить** существующий (если в `content` есть `item`) |
| `gitlab:<alias>` | Операции в репозитории: ветка, MR, issue, комментарий |
| `bitrix:<alias>` | Проставить статус обращения Bitrix (`Closed` / `Rejected`), id — из описания задачи |
| `pachka:<alias>` | Отправить сообщение в чат Пачки через API (или в ЛС — у `dm`-провайдера) |
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

**Для `to: taiga:*` с полем `item`** — обновление существующего item'а вместо создания:

```json
"content": {
  "item": "{{taskId}}",                       // id item'а Taiga (обязателен для режима обновления)
  "customFields": { "MR": "{{mrUrl}}", "Ветка": "{{branch}}" },
  "status": "In progress",                    // опционально: имя статуса
  "assigneeEmail": "{{assigneeEmail}}",       // опционально: участник проекта по email
  "comment": "Ветка: {{branch}}"              // опционально: комментарий к item'у
}
```

`customFields` — имена кастомных полей проекта (без учёта регистра); остальные значения полей сохраняются. Неизвестное имя поля — warning, шаг идёт дальше; неизвестный статус — ошибка со списком доступных. Поле, чей шаблон разрешился в пустую строку, **не перезаписывается**: шаг заполняет поля автоматически, поэтому ещё не созданный MR не должен стирать уже записанный.

**Для `to: gitlab:*`** — операции в репозитории; выполняются в порядке `branch` → `mr` → `issue` → `comment`, объявлен должен быть хотя бы один:

```jsonc
"content": {
  "repo": "team/api",                  // опционально: перебивает repoByTag и project провайдера
  "tags": "{{labels}}",                // опционально: по каким тегам искать репо (default: labels источника)
  "branch": "feat/{{assigneeInitials}}/{{slug}}",  // без него — pattern провайдера
  "ref": "master",                     // база новой ветки (default: defaultBranch)
  "assigneeEmail": "{{assigneeEmail}}",// кого назначить на MR (default: assigneeEmail источника)
  "assigneeName": "{{assignee}}",      // источник инициалов, если нет userMap
  "mr": {
    "title": "{{taskIdentifier}} {{taskName}}",
    "description": "Задача: {{taskUrl}}",
    "target": "master",
    "draft": true,
    "labels": ["from-taiga"],
    "reviewerEmails": ["lead@example.com"]
  },
  "issue": { "title": "{{taskName}}", "description": "…", "labels": ["bug"] },
  "comment": "Ветка создана автоматически"   // комментарий к MR
}
```

Пустой объект `"mr": {}` — создать MR на дефолтах провайдера. Шаблоны внутри `mr` / `issue` резолвятся так же, как на верхнем уровне.

**Для `to: bitrix:*`** — статус обращения:

```jsonc
"content": {
  "status": "Closed",                            // "Closed" | "Rejected"
  "resolution": "Обращение закрыто в Taiga"      // опционально (default: "Статус изменён в Taiga")
}
```

Шаблонов здесь нет: id обращения шаг читает из `description` источника, а не из `content`.

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

`editPrevious` — это «эта карточка больше не актуальна»: у прошлого сообщения заменяется текст **и снимаются кнопки-действия** (кнопки-ссылки остаются). Иначе на устаревшем сообщении остаются живые callback-кнопки: нажатие изменит статус в трекере, а сообщение, которое больше не отслеживается, продолжит показывать старое состояние. Отслеживание переезжает на новое сообщение, поэтому дальше перерисовывается именно оно.

Типовое применение — повторная отправка карточки о том же item'е (историю вернули в работу и снова отдали в тестирование): новое сообщение уведомляет людей (правка сообщения в Пачке никого не уведомляет), а предыдущее сворачивается в однострочник:

```jsonc
"actions": [
  { "type": "buttons", "buttons": [/* ... */] },
  { "type": "editPrevious", "message": "🧪 [{{identifier}} {{name}}]({{issueUrl}})\n⤵️ Карточка устарела — актуальная ниже" }
]
```

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
| `taiga:*` (триггер webhook-пайплайна) | `action`, `entity`, `issueId`, `issueUrl`, `seq`, `identifier`, `name`, `title`, `description`, `project`, `status`, `statusFrom`, `type`, `priority`, `labels`, `assignee`, `assigneeEmail`, `assigneeUsername`, `assigneeInitials`, `slug`, `author`, `changedFields`, `sprint`, `parentId`, `parentSeq`, `parentIdentifier`, `parentName`, `parentUrl`, `receivedAt` |
| `taiga:*` (результат шага `to: taiga:*`) | `issueId`, `issueUrl`, `seq`, `identifier`, `name`, `title`, `description`, `labels`, `project`, `action`, `status`, `assignee`, `type`, `priority` |
| `gitlab:*` (триггер webhook-пайплайна) | `event`, `action`, `state`, `repo`, `repoUrl`, `branch`, `target`, `mrIid`, `mrUrl`, `mrTitle`, `draft`, `merged`, `labels`, `author`, `authorEmail`, `commits`, `lastCommit`, `sha`, `taskId`, `taskName`, `taskUrl`, `taskIdentifier`, `receivedAt` |
| `gitlab:*` (результат шага `to: gitlab:*`) | `branch`, `branchUrl`, `ref`, `repo`, `repoUrl`, `mrIid`, `mrUrl`, `mrTitle`, `mrTarget`, `issueIid`, `issueUrl`, `assignee`, `assigneeEmail`, `assigneeInitials`, `taskId`, `taskName`, `taskUrl`, `taskIdentifier`, `taskProject`, `taskStatus` |
| `bitrix:*` (результат шага `to: bitrix:*`) | `bitrixId`, `status`, `resolution`, `response`, `provider` |
| `pachka:*` | `messageId`, `chatId`, `channel`, `message` |
| `webhook:*` | `channel`, `message` |
| `form:*` (триггер) | `data`, `user`, `userId`, `chatId`, `receivedAt`, `meta` |

> `plane`, `taiga` и `gitlab` играют две роли: как **триггер** (первый шаг) дают поля события, как **результат шага** — поля того, что шаг записал.

> Outputs триггера остаются доступны всем шагам пайплайна, не только второму: `from: taiga:dev` можно указать и в третьем шаге, если нужны поля исходного события.

> У `gitlab` `issueUrl`/`issueIid` — это **issue в GitLab**. Исходная задача трекера доступна через `taskId`, `taskName`, `taskUrl`, `taskIdentifier`, `taskProject` (имя проекта в трекере) и `taskStatus` (статус задачи на момент события, с применённым `statusLabels`) — их gitlab-шаг прокидывает дальше, чтобы следующие шаги (ЛС, запись ссылки обратно в трекер) не зависели от того, что было в начале пайплайна.

Внутри своего `content` gitlab-шаг дополнительно видит вычисляемые переменные: `slug` (транслитерированное название), `branchType`, `assigneeInitials`, `assignee`, `assigneeEmail`, `repo`, `repoUrl` и `task*`. В шаблонах самого провайдера (`mr.title`, `mr.description`) доступны ещё и все outputs триггера — например `{{parentUrl}}` и `{{sprint}}`.

### `once` — шаг только один раз

```jsonc
{ "from": "gitlab:backend", "to": "pachka:dev-dm", "on": { "once": true, "content": { } } }
```

`once: true` — шаг выполняется один раз на задачу и получателя: ключ складывается из шага, `{{issueId}}`/`{{taskId}}` и отрендеренного `recipient`. Именно это не даёт отправить ЛС второй раз, если задачу снять с исполнителя и назначить ему снова (ветка и MR идемпотентны сами). Другому человеку ЛС уйдёт — у него другой ключ.

`once: "<шаблон>"` — ключ задаётся явно: `"once": "branch:{{issueId}}"` — один раз на задачу, кто бы ни был получателем.

Ключи лежат в SQLite (`PIPELINE_DB_PATH`), поэтому переживают рестарт. Ключ занимается **до** выполнения шага (две одновременные доставки не пройдут обе) и освобождается, если шаг упал, — следующее событие попробует снова. Шаги, читающие `from` пропущенного шага, пропускаются вместе с ним.

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
4. После перехода кнопки-действия заменяются набором из `feedback.buttons` для нового статуса. Кнопки-ссылки (`url`) сообщение **сохраняет**: переход меняет то, что можно сделать дальше, а не то, куда ведут ссылки — иначе после «Взять в работу» из ЛС пропали бы кнопки на задачу и MR.
5. Имена действий свободные — семантика фиксирована только для `accept`/`resume`.
6. Outputs taiga-шага включают `status` (label), `assignee`, `type`, `priority` — можно строить «живую карточку»: при смене статуса текст сообщения перерисовывается по шаблону `content.message` со свежими значениями. Шаблон ищется сначала у правила `taiga:<alias> → pachka:<target>`, а если такого нет — у шага `… → pachka:<target>` того пайплайна, который запускает этот же taiga-провайдер (так перерисовывается ЛС из потока «назначение → ветка + MR → ЛС», которое отправляет шаг `from: gitlab:*`). В таком шаблоне доступны и `task*` (`taskProject`, `taskIdentifier`, `taskName`, `taskUrl`, `taskStatus`), и `repo`/`branch`/`mrUrl` — ветка и MR берутся из записанной связи «ветка/MR → задача».

#### Разные кнопки у разных карточек

Один item часто показан в нескольких местах сразу — ЛС исполнителю, чат команды, канал тестировщиков — и переход значит в каждом своё: тестировщик может вернуть историю или завершить, а разработчику до её возврата нажимать нечего. Поэтому набор может объявить сам notify-шаг, полем `buttonsByStatus`; `feedback.buttons` провайдера остаётся значением по умолчанию для карточек, которые ничего не объявили:

```jsonc
{
  "from": "taiga:med2-us", "to": "pachka:med2-testing",
  "on": { "changed": "status", "status": "Testing", "content": {
    "message": "🧪 [{{identifier}} {{name}}]({{issueUrl}}) — {{status}}",
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
  }}
}
```

`actions[].buttons` — кнопки первой отправки, `buttonsByStatus` — то, чем они становятся после каждого перехода (статус без ключа = кнопок нет; кнопки-ссылки, как «Перейти на сайт», сохраняются всегда). Шаг решает, *что показать*, а `feedback.statuses` провайдера — *куда это переводит item*, поэтому имена действий берутся оттуда.

### Вебхук Taiga → синхронизация кнопок

`POST /webhook/taiga` принимает вебхуки Taiga. При смене статуса item'а в самой Taiga отслеживаемое сообщение в Пачке перерисовывается, а его кнопки обновляются — карточка не расходится с реальным состоянием. Работает в обе стороны: переход `Done → To do` вернёт карточке и статус, и кнопки нового статуса (нужна запись в `feedback.buttons` для него).

Настройка в Taiga (Settings → Integrations → Webhooks):
- **URL**: `https://<хост-сервиса>/webhook/taiga`
- **Secret key**: произвольная строка; та же строка — в env `TAIGA_WEBHOOK_SECRET`. Подпись — HMAC-SHA1 от raw body в `X-TAIGA-WEBHOOK-SIGNATURE`; при пустом секрете подпись не проверяется.

Провайдер определяется по slug проекта из `data.project.permalink` **и** по `entity`: один проект бывает подключён двумя провайдерами (его задачи и его user story), и карточка — дело того, чья сущность совпала с сущностью события. Тестовый пинг Taiga (`action: "test"`) отвечает `200 ok`.

Синхронизация кнопок и пайплайны-триггеры — независимые вещи: одно событие может и перерисовать отслеживаемую карточку, и запустить пайплайн, и падение одного не скрывает другое. В ответе роута это два разных счётчика: `{ "ok": true, "updated": <сообщений>, "triggered": <пайплайнов> }`.

---

## Заявка из Bitrix → задача в Taiga → закрытие обратно в Bitrix

Обратная связь с Bitrix: заявка приходит на intake-эндпоинт, BitrixID остаётся в описании задачи, а закрытие задачи в Taiga проставляет статус обращению.

```json
[
  [
    {
      "from": "api:intake-support", "to": "taiga:ikn",
      "on": {
        "action": "create",
        "content": {
          "name": "{{body.name}}",
          "description": "{{body.description}}\n\n---\n\n**BitrixID:** {{body.bitrixId}}  \n**BitrixURL:** {{body.bitrixLink}}"
        }
      }
    }
  ],
  [
    {
      "from": "taiga:ikn", "to": "bitrix:support",
      "on": {
        "action": "close", "status": "Closed",
        "content": { "status": "Closed", "resolution": "Обращение закрыто в Taiga" }
      }
    }
  ],
  [
    {
      "from": "taiga:ikn", "to": "bitrix:support",
      "on": {
        "action": "close", "status": "Rejected",
        "content": { "status": "Rejected", "resolution": "Обращение отклонено в Taiga" }
      }
    }
  ]
]
```

- Единственный канал связи между системами — строка `**BitrixID:** 12345` в описании задачи, поэтому intake-шаг обязан её записать. Задача, созданная не из Bitrix, просто пропустит шаг (warning в лог).
- `action: "close"` — Taiga присылает закрытие отдельным событием; `status` разделяет «закрыто» и «отклонено», так что на каждый статус Bitrix нужно своё правило.
- Статусов у провайдера только два — `Closed` и `Rejected`; любое другое значение `content.status` отлавливается валидацией конфига при старте.

---

## Задача назначена → ветка, draft MR и ЛС исполнителю

Сценарий целиком декларативный: вебхук Taiga запускает пайплайн из четырёх шагов, а вебхук GitLab — обратный пайплайн, который закрывает задачу, когда MR влит. Связь человека между системами — по email: Taiga (membership) → GitLab (`userMap` / `groups` / поиск) → Пачка (кастомное поле «Рабочая почта»).

```json
{
  "providers": [
    { "type": "taiga", "alias": "dev", "baseUrl": "https://tasks.example.com", "project": "dev",
      "entity": "user_story",
      "feedback": {
        "statuses": { "accept": "In progress", "pause": "On pause", "close": "Done" },
        "buttons": {
          "In progress": [{ "text": "✅ Завершить", "action": "close" }]
        },
        "statusLabels": { "New": "Новая 🌱", "In progress": "В работе 🚀" },
        "workEmailField": "Рабочая почта"
      }
    },
    { "type": "gitlab", "alias": "backend", "baseUrl": "https://git.example.com",
      "project": "team/backend", "defaultBranch": "master",
      "repoByTag": { "frontend": "team/web" } },
    { "type": "pachka", "alias": "dev-dm", "dm": true },
    { "type": "pachka", "alias": "dev-team", "chatId": 12345678 }
  ],
  "rules": [
    [
      {
        "from": "taiga:dev", "to": "gitlab:backend",
        "on": {
          "changed": "assigned_to", "assigned": "first",
          "content": {
            "branch": "feat/{{assigneeInitials}}/{{slug}}",
            "mr": {
              "title": "{{taskIdentifier}} {{taskName}}",
              "description": "Задача в Taiga: {{taskUrl}}\n\nИсполнитель: {{assignee}}"
            }
          }
        }
      },
      {
        "from": "gitlab:backend", "to": "taiga:dev",
        "on": {
          "content": {
            "item": "{{taskId}}",
            "customFields": { "Gitlab MR": "{{mrUrl}}", "Ветка": "{{branch}}" }
          }
        }
      },
      {
        "from": "gitlab:backend", "to": "pachka:dev-dm",
        "on": {
          "once": true,
          "content": {
            "recipient": "{{assigneeEmail}}",
            "message": "🆕 **[{{taskProject}}] Вам назначена задача**\n[{{taskIdentifier}} {{taskName}}]({{taskUrl}})\n\n📋 Статус: {{taskStatus}}\nВетка: `{{branch}}`",
            "actions": [
              { "type": "buttons", "buttons": [
                { "text": "📋 Задача", "url": "{{taskUrl}}" },
                { "text": "🔀 MR", "url": "{{mrUrl}}" },
                { "text": "👍 Взять в работу", "callbackData": "taiga:dev:accept:{{taskId}}" }
              ]}
            ]
          }
        }
      },
      {
        "from": "gitlab:backend", "to": "pachka:dev-team",
        "on": {
          "content": { "message": "🔀 {{assignee}} → {{taskIdentifier}}, MR: {{mrUrl}}" }
        }
      }
    ],
    [
      {
        "from": "gitlab:backend", "to": "taiga:dev",
        "on": {
          "event": "merge_request", "action": "merge", "target": "master",
          "content": {
            "item": "{{taskId}}",
            "status": "Done",
            "comment": "MR {{mrUrl}} влит в {{target}} ({{author}})"
          }
        }
      },
      {
        "from": "gitlab:backend", "to": "pachka:dev-team",
        "on": {
          "content": { "message": "✅ {{taskIdentifier}} {{taskName}} — MR влит в {{target}}" }
        }
      }
    ]
  ]
}
```

Что происходит по шагам:

1. **Событие.** В Taiga у user story появился первый исполнитель → `POST /webhook/taiga`. Email исполнителя подтягивается из memberships проекта (в самом вебхуке email нет — только id, username и имя).
2. **GitLab.** Репозиторий — по тегу задачи (`repoByTag`), иначе `project`. Создаётся ветка `feat/am/<название-латиницей>` от `master` и draft MR в `master`, исполнитель MR — найденный по email пользователь GitLab. Если ветка/MR уже есть — переиспользуются.
3. **Taiga.** Ссылка на MR и имя ветки пишутся в кастомные поля задачи.
4. **Пачка.** ЛС исполнителю (поиск по «Рабочей почте») с кнопками на задачу, MR и «Взять в работу», плюс короткая строка в чат команды. У шага ЛС стоит `once: true` — повторное назначение той же задачи тому же человеку второго сообщения не даёт.
5. **Кнопка «Взять в работу»** — это обычный [feedback](#обратная-связь-пачка--taiga-feedback): меняет статус в Taiga и назначает нажавшего. Карточка ЛС перерисовывается по своему же шаблону (его ищут и у правила `taiga:* → pachka:*`, и у шага этого пайплайна — здесь источник шага `gitlab:*`), поэтому `{{taskStatus}}` показывает новый статус, а `repo`, `branch` и `mrUrl` берутся из записанной связи «ветка/MR → задача». Кнопки-действия меняются: «Взять в работу» уступает место «На ревью» и «Пауза», а кнопки-ссылки на задачу и MR остаются на месте. То же самое происходит, когда статус меняют в самой Taiga — в том числе обратно из `Done`.
6. **MR влит.** GitLab присылает `merge_request` / `merge` на `POST /webhook/gitlab`. По MR (или по имени его ветки) находится связанная задача, её статус переводится в `Done`, в задачу уходит комментарий со ссылкой на MR, а в чат команды — строка о влитии. Если условие `target: "master"` не выполнено (влили в релизную ветку), пайплайн не запускается.

Что нужно подготовить вне конфига:

- вебхук в Taiga: **Settings → Integrations → Webhooks**, URL `https://<хост>/webhook/taiga`, secret = `TAIGA_WEBHOOK_SECRET`;
- вебхук в GitLab: **Settings → Webhooks**, URL `https://<хост>/webhook/gitlab`, secret token = `GITLAB_WEBHOOK_SECRET`, триггер *Merge request events*;
- названия кастомных полей в `customFields` должны совпадать с теми, что есть в проекте Taiga (здесь «Gitlab MR» и «Ветка»); поля, которого в проекте нет, шаг не создаёт — пишет warning и идёт дальше, так что ЛС всё равно отправится;
- кастомное поле профиля «Рабочая почта» в Пачке у исполнителей; email должен совпадать с email участника проекта Taiga;
- токен GitLab: админский PAT ищет исполнителя по приватному email; group access token (роль Developer, скоуп `api`) прав требует меньше — тогда укажите `groups` или `userMap`.

---

## Все задачи истории готовы → user story в тестирование

Передача задачи в тестирование — это «моя часть работы сделана», а не «можно тестировать». User story делается несколькими задачами, и каждая переведённая в `Ready for Test` видна в Taiga как прогресс, но e2e-тестировать историю есть смысл только когда готова **последняя** из них. Поэтому последняя задача переводит саму историю в `Testing`, и уже это событие уходит карточкой в канал тестировщиков.

Нужны два провайдера на один проект Taiga: один видит его задачи, другой — его user story (у задач и историй разные наборы статусов, и переводить их нужно по-разному).

```jsonc
{
  "providers": [
    { "type": "taiga", "alias": "med2", "baseUrl": "https://tasks.example.com", "project": "med-20",
      "entity": "task",
      "feedback": {
        "statuses": { "accept": "In Progress", "pause": "Pause", "resume": "In Progress",
                      "review": "Review", "ready": "Ready for Test", "close": "Done" },
        "buttons": {
          "In Progress": [
            { "text": "🧪 Готово к тесту", "action": "ready" },
            { "text": "👀 На ревью", "action": "review" },
            { "text": "⏸️ Пауза", "action": "pause" }
          ],
          "Ready for Test": [{ "text": "↩️ Вернуть в работу", "action": "resume" }]
        },
        "workEmailField": "Рабочая почта"
      } },
    { "type": "taiga", "alias": "med2-us", "baseUrl": "https://tasks.example.com", "project": "med-20",
      "entity": "user_story",
      "feedback": {
        "statuses": { "rework": "In Progress", "close": "Done" },
        "statusLabels": { "Testing": "Тестирование 🧪", "In Progress": "В работе 🚀", "Done": "Готово ✅" },
        "workEmailField": "Рабочая почта"
      } },
    { "type": "pachka", "alias": "med2-testing", "chatId": 45932414 }
  ],
  "rules": [
    [
      {
        "from": "taiga:med2", "to": "taiga:med2-us",
        "on": {
          "entity": "task", "changed": "status", "status": "Ready for Test",
          "allTasks": ["Ready for Test", "Done"],
          "content": {
            "item": "{{parentId}}",
            "status": "Testing",
            "comment": "🧪 Все задачи истории готовы к тестированию (последняя — {{identifier}} {{name}})"
          }
        }
      }
    ],
    [
      {
        "from": "taiga:med2-us", "to": "pachka:med2-testing",
        "on": {
          "changed": "status", "status": "Testing",
          "content": {
            "message": "🧪 **Готово к тестированию**\n[{{identifier}} {{name}}]({{issueUrl}})\n\n🦸‍♂️ **Ответственный:** {{assignee}}\n{{#sprint}}🏁 **Спринт:** {{sprint}}\n{{/sprint}}📋 **Статус:** {{status}}",
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
  ]
}
```

Что происходит:

1. **Разработчик** жмёт «🧪 Готово к тесту» на карточке задачи (ЛС или чат команды) — либо просто переносит задачу в `Ready for Test` в Taiga. Это обычный [feedback](#обратная-связь-пачка--taiga-feedback), действие `ready`.
2. **Taiga** присылает вебхук о смене статуса задачи. Первый пайплайн спрашивает у API остальные задачи родительской истории: пока хоть одна не в `Ready for Test` / `Done`, он не делает ничего.
3. **Последняя задача** переводит user story в `Testing` и оставляет в ней комментарий, какой задачей история закрылась.
4. **Taiga** присылает вебхук уже о смене статуса истории — его ловит второй пайплайн и отправляет карточку в канал тестировщиков: ссылка на историю, ответственный, спринт, статус и кнопки.
5. **Кнопки тестировщика** — тот же feedback, но провайдера `taiga:med2-us`: «Вернуть в работу» ставит истории `In Progress`, «Завершить» — `Done`. Действие `rework` названо так намеренно: `resume` и `accept` ещё и назначают нажавшего исполнителем, а тестировщик историю не делает. Кнопка «Перейти на сайт» — обычная ссылка, переходы её не убирают.
6. **Возврат в работу** статусы задач не трогает: они остаются в `Ready for Test`, и пайплайн роллапа не сработает, пока какую-нибудь задачу не вернут в работу и снова не отдадут в тест. Тогда история снова уйдёт в `Testing`, в канал прилетит **новая** карточка (чтобы тестировщиков уведомило — правка сообщения в Пачке не уведомляет), а предыдущая свернётся в однострочник и потеряет кнопки — за это отвечает action `editPrevious` в том же шаге.

Подводные камни:

- Имена статусов в `allTasks` и в `feedback.statuses` — ровно те, что в проекте Taiga (`Ready for Test`, не `Testing`); регистр не важен, опечатка — да: ненайденный статус попадёт в warning, а условие не сойдётся.
- В `allTasks` нужны **все** «финальные» статусы задачи. Задача, закрытая в `Done` раньше остальных, иначе навсегда заблокирует роллап.
- История, у которой ещё нет задач, в `Testing` сама не уедет — это осознанно.
- Карточка отслеживается по id истории, поэтому вторая карточка на ту же историю заменяет первую. Чтобы в чате не оставалось двух одинаковых карточек с живыми кнопками, у шага стоит action `editPrevious`: предыдущая сворачивается в однострочник и теряет кнопки-действия. Без него старое сообщение остаётся полноценной карточкой, которая больше не обновляется, а кнопки на ней продолжают менять статус.

Что нужно подготовить вне конфига: вебхук Taiga (**Settings → Integrations → Webhooks**, URL `https://<хост>/webhook/taiga`), исходящий вебхук Пачки на `POST /webhook/pachka` для кнопок и статус `Testing` у user story в проекте.

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
| `GITLAB_TOKEN` / `GITLAB_TOKEN_<ALIAS>` | при gitlab-провайдерах | Токен GitLab со скоупом `api`: group/project access token с ролью Developer, PAT бота или админский PAT (последний ищет людей по приватному email) |
| `GITLAB_WEBHOOK_SECRET[_<ALIAS>]` | нет | Secret token вебхука GitLab (`X-Gitlab-Token`); без него payload не проверяется |
| `BITRIX_API_TOKEN` / `BITRIX_API_TOKEN_<ALIAS>` | при bitrix-провайдерах | Токен Bitrix для смены статуса обращения |
| `INTAKE_API_KEY` / `INTAKE_API_KEY_<ALIAS>` | при api-провайдерах | Ключ intake-эндпоинта (кроме `"auth": false`) |
| `MESSAGE_DB_PATH` | нет | Путь к SQLite с отправленными сообщениями (default: `data/messages.sqlite`) |
| `PIPELINE_DB_PATH` | нет | Путь к SQLite с состоянием пайплайнов: `once`-ключи и связи ветка/MR → задача (default: `data/pipeline.sqlite`) |
| `PORT` | нет | Порт HTTP-сервера (default: `3000`) |
| `LOG_LEVEL` | нет | `debug` \| `info` \| `warn` \| `error` (default: `info`) |
| `ENV_FILE` | нет | Путь к env-файлу (default: `.env`) |
| `DOTENV_OVERRIDE` | нет | `false` — не перекрывать унаследованное окружение значениями из `.env` |

\* достаточно одного из вариантов. Схема резолва per-alias везде одинаковая: alias в верхнем регистре, не-буквенно-цифровые символы → `_`, откат на переменную без суффикса.

### `.env` главнее шелла

При старте бридж сам читает `.env` и **перекрывает** им уже унаследованные переменные (`src/core/env.ts`). Сам bun так не делает: уже существующая переменная сильнее файла, и глобально заданный `TAIGA_USERNAME` (переменная среды Windows, профиль шелла, `docker run -e`) тихо уводит бридж не в ту учётку — выглядит это как 401 от Taiga с верным токеном в файле. Перекрытые переменные перечисляются в warning при старте (только имена, без значений). Если окружение задаётся снаружи намеренно (CI, k8s, `docker run -e`) — `DOTENV_OVERRIDE=false`.

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
7. Все плейсхолдеры в шаблоне ветки обязаны разрешиться: пустой `{{slug}}` или `{{assigneeInitials}}` — ошибка шага, а не ветка вида `feat/`.
8. Ветка и MR идемпотентны сами, уведомления — нет: ЛС и сообщения в чат отправятся заново, если то же событие прилетит вне окна дедупликации (~10 сек) или задачу снимут с исполнителя и назначат снова. Лечится `once: true` на notify-шаге.
9. MR по ветке без коммитов GitLab создаёт (так же работает его собственная кнопка «создать MR из задачи»), но если инстанс это отклонит, шаг не падает: ветка остаётся, `mrUrl` пустой, причина — в логе. В шаблоне это можно обработать условным блоком `{{#mrUrl}}…{{/mrUrl}}`.
10. У `gitlab`-шага `{{issueUrl}}` — это issue GitLab, а не задача трекера; для задачи есть `{{taskUrl}}`.
11. Кастомного поля, которого нет в проекте Taiga, шаг не создаёт: пишет warning со списком существующих и продолжает. Опечатка в названии поля выглядит как «ничего не записалось» — проверяйте лог.
12. Обратный пайплайн (`from: gitlab:*`) находит задачу только по связи, записанной шагом `to: gitlab:*`. Для ветки и MR, сделанных до появления этой связи (или руками, с другим именем ветки), `{{taskId}}` будет пустым — шаг `to: taiga:*` пропустится с warning.
13. `data/pipeline.sqlite` — состояние, а не кеш: если удалить файл, `once`-ключи забудутся (возможны повторные уведомления), а связи ветка → задача потеряются.
14. Синхронизация по вебхуку Taiga трогает **все** отслеживаемые сообщения этого item'а: если в пайплайне есть и ЛС, и сообщение в чат команды, при смене статуса кнопки из `feedback.buttons` появятся у обоих. Если в общем чате кнопки не нужны, отправляйте туда уведомление отдельным пайплайном (по событию, а не по тому же item'у) либо через `webhook:*`-цель.
