# plane-pachka (DevFlow Bridge)

Мост между трекерами задач ([Plane](https://plane.so), [Taiga](https://taiga.io)) и мессенджером [Пачка](https://pachca.com). События и заявки проходят через декларативные **пайплайны**: вебхук / HTTP-запрос / форма Пачки на входе → создание задачи и/или уведомление на выходе.

## Главное

- **Пайплайны `from → to`** — цепочки шагов с передачей данных: одно событие может создать задачу в трекере и тут же отправить уведомление с кнопками.
- **Уведомления из Plane** — вебхуки Plane фильтруются по действию, состоянию, группе состояний, приоритету и превращаются в сообщения Пачки по шаблонам с плейсхолдерами `{{...}}`.
- **Intake API** — HTTP-эндпоинты (защищённые API-ключом) для приёма заявок извне: создание задачи в Plane или Taiga с вложениями + уведомление.
- **Формы Пачки** — кнопка в чате открывает модальную форму, отправка формы запускает пайплайн (заявка → задача → уведомление).
- **Живые карточки Taiga** — кнопки под сообщением («Взять в работу», «Завершить»...) меняют статус и исполнителя в Taiga; вебхук Taiga синхронизирует кнопки и текст карточки обратно.
- **Несколько инстансов** — любое число провайдеров Plane/Taiga/чатов Пачки с раздельными ключами через env.

Вся настройка — один JSON-файл без кода и без секретов. **[→ Статья: как работать с конфигурацией](docs/configuration.md)**

## Быстрый старт

```bash
cp .env.example .env       # заполнить ключи (см. статью по конфигурации)
mkdir -p config            # создать config/default.json
bun install
bun run dev                # dev с hot reload; production: bun run start
```

Минимальный `config/default.json` (уведомления о завершённых задачах Plane):

```json
{
  "providers": [
    { "type": "plane", "alias": "dev", "baseUrl": "https://plane.example.com", "workspace": "team", "project": "Backend" },
    { "type": "pachka", "alias": "dev-chat", "chatId": 12345678 }
  ],
  "rules": [
    [
      {
        "from": "plane:dev", "to": "pachka:dev-chat",
        "on": {
          "action": "update", "stateGroup": "completed",
          "content": {
            "message": "✅ #{{seq}} «{{title}}»",
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

Осталось создать вебхук в Plane (Workspace Settings → Webhooks → URL `https://<хост>/webhook/plane`) — подробности и все сценарии в [статье по конфигурации](docs/configuration.md).

### Docker

```bash
docker compose up -d   # конфиг монтируется из ./config, секреты — через env
```

## HTTP-эндпоинты

| Эндпоинт | Назначение |
|---|---|
| `GET /health` | Проверка живости — `{ "ok": true }` |
| `POST /webhook/plane` | Вебхуки Plane (подпись HMAC-SHA256 при заданном `PLANE_WEBHOOK_SECRET`) |
| `POST /webhook/taiga` | Вебхуки Taiga (подпись HMAC-SHA1 при заданном `TAIGA_WEBHOOK_SECRET`) |
| `POST /webhook/pachka` | Исходящий вебхук Пачки: нажатия кнопок, открытие и отправка форм |
| `POST <endpoint>` | Intake-эндпоинты из конфига (по одному на `api`-провайдера), auth по API-ключу |

Формальное описание — [docs/openapi.yaml](docs/openapi.yaml).

## Два режима доставки в Пачку

1. **API-режим** (`pachka`-провайдер + `PACHKA_API_TOKEN`) — кнопки, реакции, треды, редактирование, формы.
2. **Webhook-режим** (`webhook`-провайдер) — только текст, токен не нужен.

## Разработка

Bun + Elysia + TypeScript, модульный монолит по Clean Architecture (`domain` / `application` / `infrastructure` в `src/modules/`). Состояние (ID отправленных сообщений) — в bun:sqlite.

```bash
bun test               # все тесты
bun test tests/unit/   # unit (без внешних сервисов)
bun test tests/e2e/    # e2e (нужны PACHKA_TEST_TOKEN и PACHKA_TEST_CHAT_ID в .env.test)
```

## Документация

- **[Конфигурация](docs/configuration.md)** — провайдеры, пайплайны, шаблоны, формы, feedback-цикл Taiga, переменные окружения
- [OpenAPI-спецификация](docs/openapi.yaml) — HTTP API
- [CLAUDE.md](CLAUDE.md) — архитектура и правила генерации конфига
