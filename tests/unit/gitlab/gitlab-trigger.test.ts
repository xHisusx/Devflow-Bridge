import { describe, test, expect } from "bun:test";
import {
  branchFromRef,
  buildGitLabTriggerOutputs,
  extractGitLabFacts,
  matchesGitLabCondition,
} from "../../../src/modules/gitlab/domain/services/gitlab-trigger";
import { coversRepo } from "../../../src/modules/gitlab/application/use-cases/process-gitlab-trigger";
import { getProviderOutputs } from "../../../src/core/provider-schema";
import type { GitLabProvider } from "../../../src/core/config";
import type { GitLabWebhookPayload } from "../../../src/modules/gitlab/domain/entities/gitlab-webhook-payload";

const MERGED: GitLabWebhookPayload = {
  object_kind: "merge_request",
  user: { id: 55, name: "Алексей Махов", username: "amakhov" },
  project: { id: 1, path_with_namespace: "team/backend", web_url: "https://git.test/team/backend" },
  object_attributes: {
    iid: 7,
    title: "#42 Исправить баг в отчётах",
    state: "merged",
    action: "merge",
    source_branch: "feat/am/ispravit-bag-v-otchetah",
    target_branch: "master",
    url: "https://git.test/team/backend/-/merge_requests/7",
    draft: false,
    last_commit: { id: "abc1234", title: "Fix the report" },
    labels: [{ title: "backend" }],
  },
};

const PUSH: GitLabWebhookPayload = {
  object_kind: "push",
  ref: "refs/heads/feat/am/ispravit-bag-v-otchetah",
  user_name: "Алексей Махов",
  user_email: "a.makhov@example.com",
  project: { path_with_namespace: "team/backend" },
  commits: [{ id: "c1", title: "wip" }, { id: "c2", message: "Fix it\n\nmore" }],
  total_commits_count: 2,
  checkout_sha: "c2",
};

describe("extractGitLabFacts", () => {
  test("a merged merge request", () => {
    const facts = extractGitLabFacts(MERGED);

    expect(facts).toEqual({
      event: "merge_request",
      action: "merge",
      state: "merged",
      repo: "team/backend",
      branch: "feat/am/ispravit-bag-v-otchetah",
      target: "master",
      draft: false,
      merged: true,
      labels: ["backend"],
    });
  });

  test("a push names the branch it went to", () => {
    const facts = extractGitLabFacts(PUSH);

    expect(facts.event).toBe("push");
    expect(facts.action).toBe("push");
    expect(facts.branch).toBe("feat/am/ispravit-bag-v-otchetah");
    expect(facts.merged).toBe(false);
  });

  test("the deprecated work_in_progress flag still reads as draft", () => {
    const facts = extractGitLabFacts({
      object_kind: "merge_request",
      object_attributes: { action: "open", state: "opened", work_in_progress: true },
    });

    expect(facts.draft).toBe(true);
  });

  test("branchFromRef strips the ref prefix", () => {
    expect(branchFromRef("refs/heads/master")).toBe("master");
    expect(branchFromRef("refs/tags/v1.2")).toBe("v1.2");
    expect(branchFromRef(undefined)).toBe("");
  });
});

describe("matchesGitLabCondition", () => {
  const facts = extractGitLabFacts(MERGED);

  test("no conditions matches everything", () => {
    expect(matchesGitLabCondition({ content: {} }, facts)).toBe(true);
  });

  test("event + action + target all have to hold", () => {
    expect(
      matchesGitLabCondition(
        { event: "merge_request", action: "merge", target: "master", content: {} },
        facts,
      ),
    ).toBe(true);
    expect(matchesGitLabCondition({ action: "merge", target: "develop", content: {} }, facts)).toBe(false);
    expect(matchesGitLabCondition({ event: "push", content: {} }, facts)).toBe(false);
  });

  test("a list of values is an OR", () => {
    expect(matchesGitLabCondition({ action: ["close", "merge"], content: {} }, facts)).toBe(true);
    expect(matchesGitLabCondition({ action: ["close", "reopen"], content: {} }, facts)).toBe(false);
  });

  test("state and draft are matched as given", () => {
    expect(matchesGitLabCondition({ state: "merged", content: {} }, facts)).toBe(true);
    expect(matchesGitLabCondition({ draft: false, content: {} }, facts)).toBe(true);
    expect(matchesGitLabCondition({ draft: true, content: {} }, facts)).toBe(false);
  });

  test("labels match when any of them is set", () => {
    expect(matchesGitLabCondition({ labels: ["frontend", "backend"], content: {} }, facts)).toBe(true);
    expect(matchesGitLabCondition({ labels: "frontend", content: {} }, facts)).toBe(false);
  });

  test("a push pipeline can be pinned to one branch", () => {
    const push = extractGitLabFacts({
      object_kind: "push",
      ref: "refs/heads/master",
      project: { path_with_namespace: "team/backend" },
    });

    expect(matchesGitLabCondition({ event: "push", branch: "master", content: {} }, push)).toBe(true);
    expect(matchesGitLabCondition({ event: "push", branch: "develop", content: {} }, push)).toBe(false);
  });
});

describe("trigger outputs", () => {
  test("they match the declared gitlab trigger schema", () => {
    const produced = buildGitLabTriggerOutputs({
      event: "merge_request", action: "merge", state: "merged", repo: "team/backend",
      repoUrl: "https://git.test/team/backend", branch: "feat/am/x", target: "master",
      mrIid: 7, mrUrl: "https://git.test/mr/7", mrTitle: "t", draft: false, merged: true,
      labels: [], author: "a", authorEmail: "a@b.c", commits: 2, lastCommit: "Fix", sha: "c2",
      taskId: "777", taskName: "n", taskUrl: "u", taskIdentifier: "#42",
      receivedAt: "11.07.2026 08:03",
    });

    const sorted = (xs: readonly string[]) => [...xs].sort();
    expect(sorted(Object.keys(produced))).toEqual(sorted(getProviderOutputs("gitlab", "trigger")));
  });

  test("the trigger and step schemas are different roles of the same provider", () => {
    expect(getProviderOutputs("gitlab", "trigger")).not.toEqual(getProviderOutputs("gitlab", "step"));
    expect(getProviderOutputs("gitlab", "trigger")).toContain("merged");
    expect(getProviderOutputs("gitlab", "step")).toContain("branchUrl");
  });
});

describe("coversRepo", () => {
  const provider: GitLabProvider = {
    type: "gitlab",
    alias: "backend",
    baseUrl: "https://git.test",
    project: "team/backend",
    repoByTag: { frontend: "team/web" },
    groups: ["platform"],
  };

  test("the default repository, the tag map and anything under a listed group", () => {
    expect(coversRepo(provider, "team/backend")).toBe(true);
    expect(coversRepo(provider, "TEAM/Backend")).toBe(true);
    expect(coversRepo(provider, "team/web")).toBe(true);
    expect(coversRepo(provider, "platform/anything")).toBe(true);
    expect(coversRepo(provider, "other/repo")).toBe(false);
    expect(coversRepo(provider, "")).toBe(false);
  });
});

/**
 * An instance-wide **system hook** (Admin Area -> System Hooks) is the only way to get one
 * webhook with one secret token without a Premium licence — group webhooks are paid. It delivers
 * every project's events, plus instance events (user_create, project_create, ...), so the trigger
 * has to be unbothered by all of it.
 */
describe("system hook payloads", () => {
  const provider: GitLabProvider = {
    type: "gitlab",
    alias: "med2",
    baseUrl: "https://git.test",
    project: "wonder-tist/med-2.0",
    groups: ["wonder-tist"],
  };

  test("a merge_request system hook reads exactly like a project one", () => {
    // shape per the docs shipped with GitLab 13.12: top-level project.path_with_namespace,
    // object_attributes with source/target of their own
    const facts = extractGitLabFacts({
      object_kind: "merge_request",
      event_type: "merge_request",
      user: { id: 1, name: "Алексей Махов", username: "amakhov" },
      project: { id: 9, path_with_namespace: "wonder-tist/med-2.0-proxy" },
      object_attributes: {
        iid: 14,
        state: "merged",
        action: "merge",
        source_branch: "feat/am/test",
        target_branch: "master",
      },
    });

    expect(facts.event).toBe("merge_request");
    expect(facts.merged).toBe(true);
    expect(coversRepo(provider, facts.repo)).toBe(true);
    expect(
      matchesGitLabCondition({ event: "merge_request", action: "merge", target: "master", content: {} }, facts),
    ).toBe(true);
  });

  test("instance events carry no object_kind and are ignored", () => {
    const facts = extractGitLabFacts({ event_name: "user_create", name: "Иван" } as GitLabWebhookPayload);

    expect(facts.event).toBe("");
    expect(facts.repo).toBe("");
    expect(coversRepo(provider, facts.repo)).toBe(false);
  });

  test("another team's repository on the same instance is not ours", () => {
    const facts = extractGitLabFacts({
      object_kind: "merge_request",
      project: { path_with_namespace: "other-team/billing" },
      object_attributes: { iid: 3, action: "merge", target_branch: "master" },
    });

    expect(coversRepo(provider, facts.repo)).toBe(false);
  });
});
