import { describe, test, expect, mock, beforeEach } from "bun:test";
import { runGitLabStep, GitLabWriteError } from "../../../src/modules/gitlab/application/services/run-gitlab-step";
import { clearGitLabMemberCache } from "../../../src/modules/gitlab/application/services/gitlab-user-resolver";
import type { IGitLabApiClient } from "../../../src/modules/gitlab/application/ports/gitlab-api.port";
import type { GitLabProvider } from "../../../src/core/config";
import type { GitLabContent } from "../../../src/modules/messenger/domain/entities/notification";
import { gitlabClientMock } from "../../mocks";

const PROVIDER: GitLabProvider = {
  type: "gitlab",
  alias: "backend",
  baseUrl: "https://git.test",
  project: "team/backend",
  defaultBranch: "master",
};

/** Trigger outputs of a Taiga user story that just got its first assignee. */
const SOURCE: Record<string, unknown> = {
  action: "change",
  entity: "user_story",
  issueId: "777",
  issueUrl: "https://taiga.test/project/dev/us/42",
  seq: 42,
  identifier: "#42",
  name: "Исправить баг в отчётах",
  title: "Исправить баг в отчётах",
  project: "Dev",
  labels: ["backend"],
  assignee: "Алексей Махов",
  assigneeEmail: "a.makhov@example.com",
  assigneeInitials: "am",
  slug: "ispravit-bag-v-otchetah",
};

const CONTENT: GitLabContent = {
  branch: "feat/{{assigneeInitials}}/{{slug}}",
  mr: {
    title: "{{taskIdentifier}} {{taskName}}",
    description: "Taiga: {{taskUrl}}",
    assigneeEmail: "{{assigneeEmail}}",
  },
};

const createMockClient = gitlabClientMock;

describe("runGitLabStep", () => {
  // The member index is cached per instance across calls; tests must not inherit it.
  beforeEach(clearGitLabMemberCache);

  test("creates the feat/<initials>/<slug> branch and a draft MR assigned to the person", async () => {
    const client = createMockClient();

    const { outputs } = await runGitLabStep(client, PROVIDER, CONTENT, SOURCE);

    expect(client.createBranch).toHaveBeenCalledWith(
      "team/backend",
      "feat/am/ispravit-bag-v-otchetah",
      "master",
    );
    expect(client.createMergeRequest).toHaveBeenCalledWith("team/backend", {
      sourceBranch: "feat/am/ispravit-bag-v-otchetah",
      targetBranch: "master",
      title: "Draft: #42 Исправить баг в отчётах",
      description: "Taiga: https://taiga.test/project/dev/us/42",
      assigneeIds: [55],
      removeSourceBranch: true,
      squash: false,
    });
    expect(outputs.branch).toBe("feat/am/ispravit-bag-v-otchetah");
    expect(outputs.mrUrl).toBe("https://git.test/team/backend/-/merge_requests/7");
    expect(outputs.mrIid).toBe(7);
    expect(outputs.repo).toBe("team/backend");
    // task* echo the upstream item, so a DM step after this one stays self-sufficient
    expect(outputs.taskId).toBe("777");
    expect(outputs.taskUrl).toBe("https://taiga.test/project/dev/us/42");
    expect(outputs.taskName).toBe("Исправить баг в отчётах");
    expect(outputs.assigneeEmail).toBe("a.makhov@example.com");
  });

  test("falls back to the default branch pattern and computes the slug itself", async () => {
    const client = createMockClient();
    const source = { ...SOURCE, slug: undefined, assigneeInitials: undefined };

    const { outputs } = await runGitLabStep(client, PROVIDER, { mr: {} }, source);

    expect(outputs.branch).toBe("feat/am/ispravit-bag-v-otchetah");
  });

  test("reuses an existing branch and its open MR instead of creating duplicates", async () => {
    const client = createMockClient({
      getBranch: mock((_p: string, branch: string) =>
        Promise.resolve({ name: branch, webUrl: "https://git.test/b", commitSha: "x", protected: false }),
      ),
      listMergeRequests: mock(() =>
        Promise.resolve([
          {
            id: 9, iid: 9, title: "Draft: #42 Исправить баг в отчётах", description: "",
            state: "opened", draft: true, sourceBranch: "feat/am/ispravit-bag-v-otchetah",
            targetBranch: "master", webUrl: "https://git.test/mr/9", assigneeIds: [55],
          },
        ]),
      ),
    });

    const { outputs } = await runGitLabStep(client, PROVIDER, CONTENT, SOURCE);

    expect(client.createBranch).not.toHaveBeenCalled();
    expect(client.createMergeRequest).not.toHaveBeenCalled();
    expect(outputs.mrIid).toBe(9);
  });

  test("picks the repository from the provider's tag map", async () => {
    const client = createMockClient();
    const provider: GitLabProvider = {
      ...PROVIDER,
      repoByTag: { Backend: "team/api", frontend: "team/web" },
    };

    await runGitLabStep(client, provider, CONTENT, SOURCE);

    expect(client.getProject).toHaveBeenCalledWith("team/api");
  });

  test("content.repo overrides both the tag map and the provider default", async () => {
    const client = createMockClient();
    const provider: GitLabProvider = { ...PROVIDER, repoByTag: { backend: "team/api" } };

    await runGitLabStep(client, provider, { ...CONTENT, repo: "team/infra" }, SOURCE);

    expect(client.getProject).toHaveBeenCalledWith("team/infra");
  });

  test("userMap resolves the identity without an email search and overrides the initials", async () => {
    const client = createMockClient();
    const provider: GitLabProvider = {
      ...PROVIDER,
      userMap: { "A.Makhov@example.com": { username: "amakhov", initials: "amk" } },
    };

    const { outputs } = await runGitLabStep(client, provider, { mr: {} }, SOURCE);

    expect(client.findUserByEmail).not.toHaveBeenCalled();
    expect(client.findUserByUsername).toHaveBeenCalledWith("amakhov");
    expect(outputs.branch).toBe("feat/amk/ispravit-bag-v-otchetah");
  });

  test("an unresolved assignee leaves the MR unassigned instead of failing", async () => {
    const client = createMockClient({
      findUserByEmail: mock(() => Promise.resolve(null)),
      findUserByUsername: mock(() => Promise.resolve(null)),
    });

    const { outputs } = await runGitLabStep(client, PROVIDER, CONTENT, SOURCE);

    const [, payload] = (client.createMergeRequest as ReturnType<typeof mock>).mock.calls[0];
    expect(payload.assigneeIds).toBeUndefined();
    expect(outputs.assignee).toBe("Алексей Махов");
  });

  // A non-admin token cannot search people by a private email, so the fallbacks matter.
  test("without an email search the assignee is matched among the repository members", async () => {
    const client = createMockClient({
      findUserByEmail: mock(() => Promise.reject(new Error("403 Forbidden"))),
      findUserByUsername: mock(() => Promise.resolve(null)),
      listProjectMembers: mock(() =>
        Promise.resolve([
          { id: 77, username: "amakhov", name: "Alexey Makhov", webUrl: "", accessLevel: 30 },
          { id: 78, username: "someone", name: "Someone Else", webUrl: "", accessLevel: 30 },
        ]),
      ),
    });

    const { outputs } = await runGitLabStep(client, PROVIDER, CONTENT, SOURCE);

    const [, payload] = (client.createMergeRequest as ReturnType<typeof mock>).mock.calls[0];
    expect(payload.assigneeIds).toEqual([77]);
    // The tracker's spelling of the name wins over the git account's.
    expect(outputs.assignee).toBe("Алексей Махов");
  });

  test("a failed MR still returns the branch outputs", async () => {
    const client = createMockClient({
      createMergeRequest: mock(() => Promise.reject(new Error("409 branch has no commits"))),
    });

    const { outputs } = await runGitLabStep(client, PROVIDER, CONTENT, SOURCE);

    expect(outputs.branch).toBe("feat/am/ispravit-bag-v-otchetah");
    expect(outputs.mrUrl).toBe("");
    expect(outputs.mrIid).toBeNull();
  });

  test("non-draft MR keeps the plain title", async () => {
    const client = createMockClient();

    await runGitLabStep(
      client,
      PROVIDER,
      { ...CONTENT, mr: { ...CONTENT.mr, draft: false } },
      SOURCE,
    );

    const [, payload] = (client.createMergeRequest as ReturnType<typeof mock>).mock.calls[0];
    expect(payload.title).toBe("#42 Исправить баг в отчётах");
  });

  test("creates an issue and comments on the MR when asked", async () => {
    const client = createMockClient();

    const { outputs } = await runGitLabStep(
      client,
      PROVIDER,
      { ...CONTENT, issue: { title: "{{taskName}}" }, comment: "Задача: {{taskUrl}}" },
      SOURCE,
    );

    expect(client.createIssue).toHaveBeenCalledWith("team/backend", {
      title: "Исправить баг в отчётах",
      assigneeIds: [55],
    });
    expect(client.addMergeRequestNote).toHaveBeenCalledWith(
      "team/backend",
      7,
      "Задача: https://taiga.test/project/dev/us/42",
    );
    expect(outputs.issueIid).toBe(3);
  });

  test("an unreachable repository is a GitLabWriteError", async () => {
    const client = createMockClient({
      getProject: mock(() => Promise.reject(new Error("404 Project Not Found"))),
    });

    expect(runGitLabStep(client, PROVIDER, CONTENT, SOURCE)).rejects.toThrow(GitLabWriteError);
  });

  test("a branch template that resolves to nothing is a GitLabWriteError", async () => {
    const client = createMockClient();

    expect(
      runGitLabStep(client, PROVIDER, { branch: "{{missing}}" }, { name: "" }),
    ).rejects.toThrow(GitLabWriteError);
  });
});
