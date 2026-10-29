import { describe, test, expect } from "bun:test";
import { PipelineStateStore } from "../../../src/core/persistence/sqlite-pipeline-state";
import { onceKey } from "../../../src/core/pipeline";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";

const store = () => new PipelineStateStore(":memory:");

describe("PipelineStateStore: once keys", () => {
  test("the first claim wins, later ones do not", () => {
    const s = store();

    expect(s.markOnce("dm:777:a@b.c")).toBe(true);
    expect(s.markOnce("dm:777:a@b.c")).toBe(false);
    expect(s.markOnce("dm:778:a@b.c")).toBe(true);
  });

  test("a released key can be claimed again", () => {
    const s = store();

    s.markOnce("dm:777");
    s.forget("dm:777");

    expect(s.markOnce("dm:777")).toBe(true);
  });
});

describe("PipelineStateStore: task links", () => {
  const link = {
    repo: "team/backend",
    branch: "feat/am/fix",
    mrIid: 7,
    mrUrl: "https://git.test/team/backend/-/merge_requests/7",
    tracker: "taiga:dev",
    taskId: "777",
    taskUrl: "https://taiga.test/project/dev/us/42",
    taskIdentifier: "#42",
    taskName: "Исправить баг",
  };

  test("a link is found by merge request and by branch", () => {
    const s = store();
    s.rememberTaskLink(link);

    expect(s.findTaskByMr("team/backend", 7)).toEqual(link);
    expect(s.findTaskByBranch("team/backend", "feat/am/fix")).toEqual(link);
    expect(s.findTaskByMr("team/backend", 8)).toBeNull();
    expect(s.findTaskByBranch("other/repo", "feat/am/fix")).toBeNull();
  });

  test("re-running the same step updates the row instead of adding one", () => {
    const s = store();
    s.rememberTaskLink({ ...link, mrIid: null });
    s.rememberTaskLink(link);

    expect(s.findTaskByBranch("team/backend", "feat/am/fix")?.mrIid).toBe(7);
  });

  test("a later run without an MR keeps the one already recorded", () => {
    const s = store();
    s.rememberTaskLink(link);
    s.rememberTaskLink({ ...link, mrIid: null, mrUrl: "", taskName: "Переименованная задача" });

    const found = s.findTaskByMr("team/backend", 7);
    expect(found?.mrIid).toBe(7);
    expect(found?.mrUrl).toBe("https://git.test/team/backend/-/merge_requests/7");
    expect(found?.taskName).toBe("Переименованная задача");
  });

  test("a link is found by the task it was made for", () => {
    const s = store();
    s.rememberTaskLink({ ...link, repo: "team/web", branch: "feat/am/web", mrIid: null, mrUrl: "" });
    s.rememberTaskLink(link);

    // The one that already has a merge request wins, so a card can show it.
    expect(s.findLinkByTask("taiga:dev", "777")?.repo).toBe("team/backend");
    expect(s.findLinkByTask("taiga:dev", "778")).toBeNull();
    expect(s.findLinkByTask("taiga:other", "777")).toBeNull();
  });
});

describe("onceKey", () => {
  const dm: Rule = {
    from: "gitlab:backend",
    to: "pachka:dev-dm",
    on: { once: true, content: { message: "hi", recipient: "{{assigneeEmail}}" } },
  };

  test("true keys on the step, the item and the recipient", () => {
    expect(onceKey(dm, { taskId: "777", assigneeEmail: "a@b.c" })).toBe(
      "gitlab:backend->pachka:dev-dm:777:a@b.c",
    );
  });

  test("a different recipient is a different key, so a hand-off still notifies", () => {
    const first = onceKey(dm, { taskId: "777", assigneeEmail: "a@b.c" });
    const second = onceKey(dm, { taskId: "777", assigneeEmail: "i@b.c" });

    expect(first).not.toBe(second);
  });

  test("a string once is a key template", () => {
    const rule: Rule = {
      from: "taiga:dev",
      to: "gitlab:backend",
      on: { once: "branch:{{issueId}}", content: { branch: "x" } },
    };

    expect(onceKey(rule, { issueId: "777" })).toBe("taiga:dev->gitlab:backend:branch:777");
  });

  test("no guard declared, or nothing to key on, means no key", () => {
    expect(onceKey({ ...dm, on: { content: { message: "hi" } } }, { taskId: "1" })).toBeNull();
    expect(onceKey(dm, {})).toBeNull();
  });
});
