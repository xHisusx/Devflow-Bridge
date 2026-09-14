import type { BitrixStatusRequest, BitrixStatusResponse } from "../../domain/entities";

export interface IBitrixClient {
  updateStatus(request: BitrixStatusRequest): Promise<BitrixStatusResponse>;
}
