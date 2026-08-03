export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

export interface PlaneStateInline {
  id: string;
  name: string;
  color: string;
  group: StateGroup;
}

export type PlaneState = PlaneStateInline;

export interface PlaneIssue {
  id: string;
  name: string;
  description_html?: string;
  state: PlaneStateInline | string;
  priority: string;
  sequence_id: number;
  project: string;
  workspace: string;
  assignees: string[];
  labels: string[];
  created_at: string;
  updated_at: string;
  start_date?: string;
  target_date?: string;
}
