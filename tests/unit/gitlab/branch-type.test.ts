import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  DEFAULT_BRANCH_PATTERN,
  resolveBranchType,
} from "../../../src/modules/gitlab/domain/services/branch-name";
import { runGitLabStep } from "../../../src/modules/gitlab/application/services/run-gitlab-step";
import { clearGitLabMemberCache } from "../../../src/modules/gitlab/application/services/gitlab-user-resolver";
import type { GitLabProvider } from "../../../src/core/config";
import { gitlabClientMock } from "../../mocks";

/**
 * `{{branchType}}`: the first segment of a branch name, chosen by the item's tags and falling
 * back to "feat" — "[тип ветки по тегу]/[инициалы]/[название латиницей]".
 */

const PROVIDER: GitLabProvider = {
  type: "gitlab",
  alias: "med2",
  baseUrl: "https://git.test",
  project: "wonder-tist/med-2.0",
  defaultBranch: "master",
  branch: {
    typeByTag: {
      bug: "fix",
      баг: "fix",
      хотфикс: "hotfix",
      рефакторинг: "refactor",
      документация: "docs",
    },
  },
};

describe("resolveBranchType", () => {
  test("a matching tag decides the type", () => {
    expect(resolveBranchType(PROVIDER, undefined, ["баг"])).toBe("fix");
    expect(resolveBranchType(PROVIDER, undefined, ["хотфикс"])).toBe("hotfix");
  });

  test("tags are matched without case and in their own order", () => {
    expect(resolveBranchType(PROVIDER, undefined, ["BUG"])).toBe("fix");
    expect(resolveBranchType(PROVIDER, undefined, ["рефакторинг", "баг"])).toBe("refactor");
  });

  test("an unmapped tag falls back to feat", () => {
    expect(resolveBranchType(PROVIDER, undefined, ["frontend"])).toBe("feat");
    expect(resolveBranchType(PROVIDER, undefined, [])).toBe("feat");
  });

  test("the item type is consulted after the tags, so a Taiga issue of type Bug is a fix", () => {
    expect(resolveBranchType(PROVIDER, undefined, [], "Bug")).toBe("fix");
    expect(resolveBranchType(PROVIDER, undefined, ["frontend"], "Bug")).toBe("fix");
    expect(resolveBranchType(PROVIDER, undefined, [], "Enhancement")).toBe("feat");
  });

  test("an explicit value in the rule wins over everything", () => {
    expect(resolveBranchType(PROVIDER, "chore", ["баг"], "Bug")).toBe("chore");
  });

  test("the provider can change the fallback", () => {
    const provider: GitLabProvider = { ...PROVIDER, branch: { type: "task" } };
    expect(resolveBranchType(provider, undefined, ["баг"])).toBe("task");
  });

  test("the default pattern is built around it", () => {
    expect(DEFAULT_BRANCH_PATTERN).toBe("{{branchType}}/{{assigneeInitials}}/{{slug}}");
  });
});

describe("branch naming end to end", () => {
  beforeEach(clearGitLabMemberCache);

  const source = (tags: string[]) => ({
    issueId: "827",
    issueUrl: "https://tasks.test/project/med-20/task/270",
    identifier: "#270",
    name: "Исправить расчёт НМЦК при пустом справочнике",
    labels: tags,
    assignee: "Данила Коновницын",
    assigneeEmail: "konovnitsyndi@develop.mos.ru",
  });

  test("a tagged task gets fix/, an untagged one feat/", async () => {
    const client = gitlabClientMock();

    await runGitLabStep(client, PROVIDER, { branch: DEFAULT_BRANCH_PATTERN }, source(["баг"]));
    await runGitLabStep(client, PROVIDER, { branch: DEFAULT_BRANCH_PATTERN }, source([]));

    const branches = (client.createBranch as ReturnType<typeof mock>).mock.calls.map((c) => c[1]);
    expect(branches).toEqual([
      "fix/dk/ispravit-raschet-nmck-pri-pustom-spravochnike",
      "feat/dk/ispravit-raschet-nmck-pri-pustom-spravochnike",
    ]);
  });

  test("the whole name is produced without a branch template in the rule", async () => {
    const client = gitlabClientMock();

    const { outputs } = await runGitLabStep(client, PROVIDER, { mr: {} }, source(["рефакторинг"]));

    expect(outputs.branch).toBe("refactor/dk/ispravit-raschet-nmck-pri-pustom-spravochnike");
  });

  test("a long title is cut to the configured slug length", async () => {
    const client = gitlabClientMock();
    const provider: GitLabProvider = {
      ...PROVIDER,
      branch: { ...PROVIDER.branch, maxSlugLength: 24 },
    };

    const { outputs } = await runGitLabStep(client, provider, { branch: DEFAULT_BRANCH_PATTERN }, source([]));

    expect(outputs.branch).toBe("feat/dk/ispravit-raschet-nmck");
  });
});
