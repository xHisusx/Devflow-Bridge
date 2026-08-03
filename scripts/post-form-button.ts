/**
 * Post a message with a form-open button into a Pachka chat (e.g. a pinned "create request" message).
 *
 * Usage:
 *   bun run scripts/post-form-button.ts <form-alias> <pachka-alias|chatId> [message] [button-text]
 *
 * Examples:
 *   bun run scripts/post-form-button.ts devops-request devops-support
 *   bun run scripts/post-form-button.ts devops-request 41685736 "Нужна помощь DevOps?" "📝 Создать заявку"
 *
 * Requires PACHKA_API_TOKEN (Bun loads .env automatically). Config is resolved the same way
 * as the server (CONFIG_PATH -> config/default.json -> config.json).
 */
import { loadConfig } from "../src/core/config";
import { ProviderRegistry } from "../src/core/provider-registry";
import { PachkaClient } from "../src/modules/messenger/infrastructure/clients/pachka-api-client";
import { buildFormOpenData } from "../src/modules/messenger/domain/entities/form";

const [formAlias, target, messageArg, buttonTextArg] = process.argv.slice(2);

if (!formAlias || !target) {
  console.error(
    "Usage: bun run scripts/post-form-button.ts <form-alias> <pachka-alias|chatId> [message] [button-text]",
  );
  process.exit(1);
}

const token = process.env.PACHKA_API_TOKEN;
if (!token) {
  console.error("PACHKA_API_TOKEN is not set");
  process.exit(1);
}

const config = await loadConfig();
const registry = new ProviderRegistry(config.providers);

const form = registry.getForm(`form:${formAlias}`);
if (!form) {
  const available = registry
    .getByType("form")
    .map((p) => p.alias)
    .join(", ");
  console.error(`Form provider "form:${formAlias}" not found. Available: ${available || "none"}`);
  process.exit(1);
}

let chatId: number;
if (/^\d+$/.test(target)) {
  chatId = Number(target);
} else {
  const pachka = registry.getPachka(`pachka:${target}`);
  if (!pachka) {
    console.error(`Pachka provider "pachka:${target}" not found`);
    process.exit(1);
  }
  chatId = pachka.chatId;
}

const message = messageArg ?? `Чтобы создать заявку, нажмите кнопку ниже 👇`;
const buttonText = buttonTextArg ?? "📝 Создать заявку";

const client = new PachkaClient(token);
const msg = await client.sendMessage(chatId, message, {
  buttons: [{ text: buttonText, data: buildFormOpenData(formAlias) }],
});

console.log(`Message ${msg.id} sent to chat ${chatId} with button "${buttonText}" -> form "${formAlias}"`);
console.log("Tip: pin the message in the chat so the form is always one click away.");
