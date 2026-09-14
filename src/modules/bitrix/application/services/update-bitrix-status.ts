import type { BitrixContent, BitrixProvider } from "../../../../core/config";
import type { IBitrixClient } from "../ports/bitrix-api.port";

export class BitrixMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BitrixMappingError";
  }
}

/** Parse `**BitrixID:** 12345` (or the plain-text equivalent) from Taiga description. */
export function parseBitrixIdFromDescription(description: unknown): number {
  if (typeof description !== "string") {
    throw new BitrixMappingError("Taiga description is missing; BitrixID cannot be parsed");
  }

  const match = description.match(/Bitrix\s*ID\s*[*_:#-]*\s*(\d+)(?=\D|$)/i);
  if (!match) {
    throw new BitrixMappingError("BitrixID was not found in Taiga description");
  }

  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BitrixMappingError(`Invalid BitrixID in Taiga description: ${match[1]}`);
  }
  return id;
}

export async function updateBitrixStatusFromTaiga(
  client: IBitrixClient,
  provider: BitrixProvider,
  source: Record<string, unknown>,
  content: BitrixContent,
): Promise<Record<string, unknown>> {
  const bitrixId = parseBitrixIdFromDescription(source.description);
  const resolution = content.resolution ?? "Статус изменён в Taiga";
  const response = await client.updateStatus({ id: bitrixId, status: content.status, resolution });

  return { bitrixId, status: content.status, resolution, response, provider: provider.alias };
}
