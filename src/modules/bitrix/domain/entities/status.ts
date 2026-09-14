export type StatusType = "Closed" | "Rejected";

export interface BitrixStatusRequest {
  id: number;
  status: StatusType;
  resolution: string;

}

export interface BitrixStatusResponse {
  status: string;
  data: unknown[];
  errors: unknown[];
}
