import { mock } from "bun:test";
import type { PachkaMessage } from "../src/modules/messenger/domain/entities/message";
import type { IMessengerClient } from "../src/modules/messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../src/modules/messenger/application/ports/message-store.port";
import type { ITaigaApiClient } from "../src/modules/taiga/application/ports/taiga-api.port";
import type { IGitLabApiClient } from "../src/modules/gitlab/application/ports/gitlab-api.port";
import type { IBitrixClient } from "../src/modules/bitrix/application/ports/bitrix-api.port";
import type { IPipelineStateStore, TaskLink } from "../src/core/persistence/pipeline-state.port";

/**
 * Shared port mocks. Each factory returns every method of its interface, so a test only spells
 * out the calls it asserts on or needs specific data from — and adding a method to a port does
 * not break every test file.
 */

/** Well-formed PachkaMessage: the real API always returns these fields. */
export function pachkaMessage(overrides: Partial<PachkaMessage> = {}): PachkaMessage {
  return {
    id: 999,
    content: "",
    entity_type: "discussion",
    entity_id: 1,
    chat_id: 1,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function messengerClientMock(overrides: Partial<IMessengerClient> = {}): IMessengerClient {
  return {
    sendMessage: mock(() => Promise.resolve(pachkaMessage())),
    editMessage: mock(() => Promise.resolve(pachkaMessage())),
    getUser: mock(() => Promise.resolve({ id: 9 })),
    listUsers: mock(() => Promise.resolve([])),
    deleteMessage: mock(() => Promise.resolve()),
    getMessage: mock(() => Promise.resolve(pachkaMessage())),
    getMessages: mock(() => Promise.resolve([])),
    addReaction: mock(() => Promise.resolve()),
    removeReaction: mock(() => Promise.resolve()),
    getOrCreateThread: mock(() => Promise.resolve({ id: 1, chat_id: 1, message_id: 1 })),
    sendThreadMessage: mock(() => Promise.resolve(pachkaMessage({ id: 1000 }))),
    openView: mock(() => Promise.resolve()),
    ...overrides,
  };
}

export function messageStoreMock(overrides: Partial<IMessageStore> = {}): IMessageStore {
  return {
    get: mock(() => null),
    set: mock(() => {}),
    delete: mock(() => {}),
    getByPachkaMessageId: mock(() => null),
    ...overrides,
  };
}

/**
 * GitLab mock whose writes echo their inputs (branch and MR names, web URLs built from the repo
 * path), so tests can assert on what the step asked for. The default branch does not exist yet
 * and the default email lookup finds user 55.
 */
export function gitlabClientMock(overrides: Partial<IGitLabApiClient> = {}): IGitLabApiClient {
  return {
    getProject: mock((path: string) =>
      Promise.resolve({ id: 1, path, webUrl: `https://git.test/${path}`, defaultBranch: "master" }),
    ),
    listCommits: mock(() => Promise.resolve([])),
    getCommit: mock((_project: string, sha: string) =>
      Promise.resolve({
        id: sha, shortId: sha.slice(0, 8), title: "", message: "", authorName: "",
        authorEmail: "", createdAt: "", webUrl: "",
      }),
    ),
    listBranches: mock(() => Promise.resolve([])),
    getBranch: mock(() => Promise.resolve(null)),
    createBranch: mock((project: string, branch: string) =>
      Promise.resolve({
        name: branch,
        webUrl: `https://git.test/${project}/-/tree/${branch}`,
        commitSha: "abc1234",
        protected: false,
      }),
    ),
    deleteBranch: mock(() => Promise.resolve()),
    createMergeRequest: mock((project: string, payload: { title: string; sourceBranch: string; targetBranch: string }) =>
      Promise.resolve({
        id: 1,
        iid: 7,
        title: payload.title,
        description: "",
        state: "opened",
        draft: payload.title.startsWith("Draft: "),
        sourceBranch: payload.sourceBranch,
        targetBranch: payload.targetBranch,
        webUrl: `https://git.test/${project}/-/merge_requests/7`,
        assigneeIds: [],
      }),
    ),
    updateMergeRequest: mock(() => Promise.resolve(mergeRequest())),
    getMergeRequest: mock(() => Promise.resolve(mergeRequest())),
    listMergeRequests: mock(() => Promise.resolve([])),
    listMergeRequestCommits: mock(() => Promise.resolve([])),
    mergeMergeRequest: mock(() => Promise.resolve(mergeRequest({ state: "merged" }))),
    addMergeRequestNote: mock(() => Promise.resolve()),
    createIssue: mock((project: string, payload: { title: string }) =>
      Promise.resolve({
        id: 2, iid: 3, title: payload.title, description: "", state: "opened",
        webUrl: `https://git.test/${project}/-/issues/3`, labels: [],
      }),
    ),
    updateIssue: mock(() => Promise.resolve(issue())),
    getIssue: mock(() => Promise.resolve(issue())),
    listIssues: mock(() => Promise.resolve([])),
    addIssueNote: mock(() => Promise.resolve()),
    getCurrentUser: mock(() =>
      Promise.resolve({ id: 1, username: "bot", name: "Bridge Bot", webUrl: "" }),
    ),
    getUser: mock((userId: number) =>
      Promise.resolve({ id: userId, username: "mapped", name: "Mapped User", webUrl: "" }),
    ),
    findUserByEmail: mock((email: string) =>
      Promise.resolve({
        id: 55, username: "amakhov", name: "Алексей Махов", email,
        webUrl: "https://git.test/amakhov",
      }),
    ),
    findUserByUsername: mock((username: string) =>
      Promise.resolve({ id: 56, username, name: "By Username", webUrl: "" }),
    ),
    listProjectMembers: mock(() => Promise.resolve([])),
    listGroupMembers: mock(() => Promise.resolve([])),
    ...overrides,
  };
}

/** In-memory pipeline state: real semantics for `once` guards and task links, no sqlite file. */
export function pipelineStateMock(): IPipelineStateStore & { keys: Set<string>; links: TaskLink[] } {
  const keys = new Set<string>();
  const links: TaskLink[] = [];

  return {
    keys,
    links,
    markOnce(key: string) {
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    },
    forget(key: string) {
      keys.delete(key);
    },
    rememberTaskLink(link: TaskLink) {
      const existing = links.findIndex((l) => l.repo === link.repo && l.branch === link.branch);
      if (existing >= 0) links[existing] = { ...links[existing], ...link };
      else links.push(link);
    },
    findTaskByMr(repo: string, mrIid: number) {
      return links.find((l) => l.repo === repo && l.mrIid === mrIid) ?? null;
    },
    findTaskByBranch(repo: string, branch: string) {
      return links.find((l) => l.repo === repo && l.branch === branch) ?? null;
    },
  };
}

function mergeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, iid: 7, title: "", description: "", state: "opened", draft: false,
    sourceBranch: "feature", targetBranch: "master",
    webUrl: "https://git.test/mr/7", assigneeIds: [],
    ...overrides,
  };
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: 2, iid: 3, title: "", description: "", state: "opened",
    webUrl: "https://git.test/issues/3", labels: [],
    ...overrides,
  };
}

export function taigaClientMock(overrides: Partial<ITaigaApiClient> = {}): ITaigaApiClient {
  return {
    getProjectBySlug: mock(() => Promise.resolve({ id: 1, slug: "project", name: "Project" })),
    createItem: mock(() =>
      Promise.resolve({
        id: 1, ref: 1, subject: "", description: "", tags: [],
        status: null, statusName: null, typeId: null, priorityId: null,
      }),
    ),
    getItem: mock(() =>
      Promise.resolve({
        id: 1, ref: 1, subject: "", description: "", tags: [], version: 1, status: 1,
        statusName: null, assigneeName: null, typeId: null, priorityId: null,
      }),
    ),
    getItemStatuses: mock(() => Promise.resolve([])),
    getIssueTypes: mock(() => Promise.resolve([])),
    getPriorities: mock(() => Promise.resolve([])),
    updateItem: mock(() => Promise.resolve()),
    getMemberIdByEmail: mock(() => Promise.resolve(null)),
    getMemberEmailById: mock(() => Promise.resolve(null)),
    getCustomAttributes: mock(() => Promise.resolve([])),
    getCustomAttributeValues: mock(() => Promise.resolve({ values: {}, version: 1 })),
    setCustomAttributeValues: mock(() => Promise.resolve()),
    ...overrides,
  };
}

export function bitrixClientMock(overrides: Partial<IBitrixClient> = {}): IBitrixClient {
  return {
    updateStatus: mock(() => Promise.resolve({ status: "ok", data: [], errors: [] })),
    ...overrides,
  };
}
