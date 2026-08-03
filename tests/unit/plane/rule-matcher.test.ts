import { describe, test, expect } from "bun:test";
import { matchesCondition } from "../../../src/modules/plane/domain/services/rule-matcher";
import type { PlaneStateInline } from "../../../src/modules/plane/domain/entities/issue";
import type { RuleOn } from "../../../src/modules/messenger/domain/entities/notification";
import type { PlaneWebhookPayload } from "../../../src/modules/plane/domain/entities/webhook-payload";

const C = { message: "" }; // dummy content for test conditions

const state: PlaneStateInline = {
  id: "s1",
  name: "Done",
  color: "#00ff00",
  group: "completed",
};

const stateStarted: PlaneStateInline = {
  id: "s2",
  name: "In Progress",
  color: "#f59e0b",
  group: "started",
};

const stateActivity: PlaneWebhookPayload["activity"] = {
  field: "state",
  old_value: "In Progress",
  new_value: "Done",
  verb: "updated",
};

describe("matchesCondition", () => {
  test("empty condition matches everything", () => {
    expect(matchesCondition({ content: C }, "issue", "created", state, "medium")).toBe(true);
  });

  test("matches by entity", () => {
    expect(matchesCondition({ entity: "issue", content: C }, "issue", "created", state, "medium")).toBe(true);
    expect(matchesCondition({ entity: "project", content: C }, "issue", "created", state, "medium")).toBe(false);
  });

  test("matches by entity array (OR)", () => {
    expect(matchesCondition({ entity: ["issue", "work_item"], content: C }, "issue", "created", state, "medium")).toBe(true);
    expect(matchesCondition({ entity: ["project", "cycle"], content: C }, "issue", "created", state, "medium")).toBe(false);
  });

  test("matches by action", () => {
    expect(matchesCondition({ action: "create", content: C }, "issue", "created", state, "medium")).toBe(true);
    expect(matchesCondition({ action: "update", content: C }, "issue", "created", state, "medium")).toBe(false);
  });

  test("matches by state name", () => {
    const cond: RuleOn = { action: "update", state: "Done", content: C };
    expect(matchesCondition(cond, "issue", "updated", state, "medium", stateActivity)).toBe(true);
    expect(matchesCondition(cond, "issue", "updated", stateStarted, "medium", stateActivity)).toBe(false);
  });

  test("matches by state array (OR)", () => {
    const cond: RuleOn = { action: "update", state: ["Done", "In Review"], content: C };
    expect(matchesCondition(cond, "issue", "updated", state, "medium", stateActivity)).toBe(true);
  });

  test("matches by stateGroup", () => {
    const cond: RuleOn = { action: "update", stateGroup: "completed", content: C };
    expect(matchesCondition(cond, "issue", "updated", state, "medium", stateActivity)).toBe(true);
    expect(matchesCondition(cond, "issue", "updated", stateStarted, "medium", stateActivity)).toBe(false);
  });

  test("matches by priority", () => {
    expect(matchesCondition({ priority: "medium", content: C }, "issue", "created", state, "medium")).toBe(true);
    expect(matchesCondition({ priority: "urgent", content: C }, "issue", "created", state, "medium")).toBe(false);
  });

  test("matches by priority array (OR)", () => {
    expect(matchesCondition({ priority: ["urgent", "high"], content: C }, "issue", "created", state, "high")).toBe(true);
    expect(matchesCondition({ priority: ["urgent", "high"], content: C }, "issue", "created", state, "medium")).toBe(false);
  });

  test("AND: multiple conditions must all match", () => {
    const cond: RuleOn = { action: "update", state: "Done", priority: "high", content: C };
    expect(matchesCondition(cond, "issue", "updated", state, "high", stateActivity)).toBe(true);
    expect(matchesCondition(cond, "issue", "updated", state, "medium", stateActivity)).toBe(false);
  });

  test("state filter on 'updated' requires activity.field = state", () => {
    const cond: RuleOn = { action: "update", state: "Done", content: C };
    expect(matchesCondition(cond, "issue", "updated", state, "medium")).toBe(false);
    const priorityActivity = { field: "priority", old_value: "low", new_value: "high", verb: "updated" };
    expect(matchesCondition(cond, "issue", "updated", state, "medium", priorityActivity)).toBe(false);
    const stateIdActivity = { field: "state_id", old_value: "old", new_value: "new", verb: "updated" };
    expect(matchesCondition(cond, "issue", "updated", state, "medium", stateIdActivity)).toBe(true);
  });

  test("state filter on 'created' does not require activity", () => {
    const cond: RuleOn = { action: "create", state: "Done", content: C };
    expect(matchesCondition(cond, "issue", "created", state, "medium")).toBe(true);
  });

  test("null state fails state/stateGroup filters", () => {
    expect(matchesCondition({ state: "Done", content: C }, "issue", "created", null, "medium")).toBe(false);
    expect(matchesCondition({ stateGroup: "completed", content: C }, "issue", "created", null, "medium")).toBe(false);
  });
});
