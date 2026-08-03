import { describe, test, expect, beforeEach } from "bun:test";
import { MessageStore } from "../../../src/modules/messenger/infrastructure/persistence/sqlite-message-store";

describe("MessageStore", () => {
  let store: MessageStore;

  beforeEach(() => {
    store = new MessageStore(":memory:");
  });

  test("get returns null for missing entry", () => {
    expect(store.get("issue-1", "target-1")).toBeNull();
  });

  test("set + get round-trip", () => {
    store.set("issue-1", "target-1", 100, 999);
    expect(store.get("issue-1", "target-1")).toBe(100);
  });

  test("set overwrites existing entry", () => {
    store.set("issue-1", "target-1", 100, 999);
    store.set("issue-1", "target-1", 200, 999);
    expect(store.get("issue-1", "target-1")).toBe(200);
  });

  test("different targets are independent", () => {
    store.set("issue-1", "target-a", 100, 999);
    store.set("issue-1", "target-b", 200, 999);
    expect(store.get("issue-1", "target-a")).toBe(100);
    expect(store.get("issue-1", "target-b")).toBe(200);
  });

  test("delete removes entry", () => {
    store.set("issue-1", "target-1", 100, 999);
    store.delete("issue-1", "target-1");
    expect(store.get("issue-1", "target-1")).toBeNull();
  });

  test("getByPachkaMessageId reverse lookup", () => {
    store.set("issue-1", "target-1", 100, 999);
    const result = store.getByPachkaMessageId(100);
    expect(result).toEqual({ correlationId: "issue-1", target: "target-1" });
  });

  test("getByPachkaMessageId returns null for unknown", () => {
    expect(store.getByPachkaMessageId(999)).toBeNull();
  });
});
