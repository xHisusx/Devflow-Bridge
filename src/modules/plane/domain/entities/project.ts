export type PlaneEntity = "issue" | "work_item" | "task" | "project" | "cycle" | "module" | "issue_comment";

export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
  workspace: string;
}
