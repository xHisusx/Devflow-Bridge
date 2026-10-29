import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  GitLabUserResolver,
  clearGitLabMemberCache,
  usernameCandidates,
} from "../../../src/modules/gitlab/application/services/gitlab-user-resolver";
import type { GitLabProvider } from "../../../src/core/config";
import { gitlabClientMock } from "../../mocks";

/**
 * Resolving a person without an admin token: the email search no longer finds private emails, so
 * the group member index, the username guessed from the email and the loose name match carry it.
 */

const GROUP_PROVIDER: GitLabProvider = {
  type: "gitlab",
  alias: "backend",
  baseUrl: "https://git.test",
  project: "team/backend",
  groups: ["team"],
};

/** A token that cannot search users at all, as a group access token cannot. */
function restrictedClient(members: Record<string, unknown>[]) {
  return gitlabClientMock({
    findUserByEmail: mock(() => Promise.reject(new Error("403 Forbidden"))),
    findUserByUsername: mock(() => Promise.resolve(null)),
    listGroupMembers: mock(() => Promise.resolve(members as never)),
  });
}

const member = (id: number, username: string, name: string, email?: string) => ({
  id, username, name, email: email ?? null, webUrl: `https://git.test/${username}`, accessLevel: 30,
});

describe("GitLabUserResolver", () => {
  beforeEach(clearGitLabMemberCache);

  test("an explicit userMap entry wins and costs no search", async () => {
    const client = gitlabClientMock();
    const provider: GitLabProvider = {
      ...GROUP_PROVIDER,
      userMap: { "a.makhov@example.com": { userId: 42 } },
    };

    const user = await new GitLabUserResolver(client, provider).resolve("a.makhov@example.com");

    expect(user?.id).toBe(42);
    expect(client.findUserByEmail).not.toHaveBeenCalled();
    expect(client.listGroupMembers).not.toHaveBeenCalled();
  });

  test("a public email is still found by the plain search", async () => {
    const client = gitlabClientMock();

    const user = await new GitLabUserResolver(client, GROUP_PROVIDER).resolve("a.makhov@example.com");

    expect(user?.username).toBe("amakhov");
    expect(client.listGroupMembers).not.toHaveBeenCalled();
  });

  test("the group member list is searched when the email search is denied", async () => {
    const client = restrictedClient([
      member(77, "amakhov", "Alexey Makhov"),
      member(78, "someone", "Someone Else"),
    ]);

    const user = await new GitLabUserResolver(client, GROUP_PROVIDER).resolve("a.makhov@example.com");

    expect(user?.id).toBe(77);
    expect(client.listGroupMembers).toHaveBeenCalledWith("team");
    expect(client.listProjectMembers).not.toHaveBeenCalled();
  });

  test("a member whose email the instance does expose matches on it", async () => {
    const client = restrictedClient([
      member(80, "unrelated-login", "Someone", "a.makhov@example.com"),
    ]);

    const user = await new GitLabUserResolver(client, GROUP_PROVIDER).resolve("a.makhov@example.com");

    expect(user?.id).toBe(80);
  });

  test("a Cyrillic tracker name matches its Latin GitLab spelling", async () => {
    const client = restrictedClient([
      member(81, "makhov", "Alexey Makhov"),
      member(82, "ivanov", "Ivan Ivanov"),
    ]);

    const user = await new GitLabUserResolver(client, GROUP_PROVIDER).resolve(
      "login-7781@corp.example.com",
      "Алексей Махов",
    );

    expect(user?.id).toBe(81);
  });

  // Real case: the tracker has "Алексей Павлов", GitLab has "Павлов Алексей Сергеевич", and the
  // email (PavlovAS2@) gives no usable username.
  test("a name with a patronymic still matches the tracker's two-part name", async () => {
    const client = restrictedClient([
      member(91, "pavlov.a.s", "Павлов Алексей Сергеевич"),
      member(92, "makhovaa", "Махов Алексей Александрович"),
    ]);

    const user = await new GitLabUserResolver(client, GROUP_PROVIDER).resolve(
      "PavlovAS2@develop.mos.ru",
      "Алексей Павлов",
    );

    expect(user?.id).toBe(91);
  });

  test("a single shared token is not enough to pick somebody", async () => {
    const client = restrictedClient([
      member(93, "ivanovii", "Иванов Пётр Сергеевич"),
    ]);

    const user = await new GitLabUserResolver(client, GROUP_PROVIDER).resolve(
      "login-1@corp.test",
      "Иван Иванов",
    );

    expect(user).toBeNull();
  });

  test("an ambiguous name resolves to nobody rather than to the wrong person", async () => {
    const client = restrictedClient([
      member(83, "makhov1", "Alexey Makhov"),
      member(84, "makhov2", "Aleksey Mahov"),
    ]);

    const user = await new GitLabUserResolver(client, GROUP_PROVIDER).resolve(
      "login-7781@corp.example.com",
      "Алексей Махов",
    );

    expect(user).toBeNull();
  });

  test("nobody found is null, not an error", async () => {
    const client = restrictedClient([member(85, "other", "Other Person")]);

    const user = await new GitLabUserResolver(client, GROUP_PROVIDER).resolve(
      "ghost@example.com",
      "Призрак Призраков",
    );

    expect(user).toBeNull();
  });

  test("without groups the repository's own members are indexed", async () => {
    const client = gitlabClientMock({
      findUserByEmail: mock(() => Promise.resolve(null)),
      findUserByUsername: mock(() => Promise.resolve(null)),
      listProjectMembers: mock(() => Promise.resolve([member(86, "amakhov", "A M")] as never)),
    });
    const provider: GitLabProvider = { ...GROUP_PROVIDER, groups: undefined };

    const user = await new GitLabUserResolver(client, provider).resolve(
      "a.makhov@example.com",
      undefined,
      "team/api",
    );

    expect(user?.id).toBe(86);
    expect(client.listProjectMembers).toHaveBeenCalledWith("team/api");
  });

  test("the member index is fetched once and then reused", async () => {
    const client = restrictedClient([member(87, "amakhov", "Alexey Makhov")]);
    const resolver = new GitLabUserResolver(client, GROUP_PROVIDER);

    await resolver.resolve("a.makhov@example.com");
    await resolver.resolve("i.petrov@example.com");

    expect(client.listGroupMembers).toHaveBeenCalledTimes(1);
  });

  test("a username guess is the last resort", async () => {
    const client = gitlabClientMock({
      findUserByEmail: mock(() => Promise.resolve(null)),
      listGroupMembers: mock(() => Promise.resolve([])),
      findUserByUsername: mock((username: string) =>
        Promise.resolve(
          username === "a.makhov"
            ? { id: 88, username, name: "Alexey Makhov", webUrl: "" }
            : null,
        ),
      ),
    });

    const user = await new GitLabUserResolver(client, GROUP_PROVIDER).resolve("a.makhov@example.com");

    expect(user?.id).toBe(88);
  });
});

describe("usernameCandidates", () => {
  test("the local part, its joinings and the initial+surname form", () => {
    expect(usernameCandidates("a.makhov@example.com")).toEqual([
      "a.makhov",
      "amakhov",
      "a_makhov",
      "a-makhov",
    ]);
    expect(usernameCandidates("alexey_makhov@example.com")).toContain("amakhov");
    expect(usernameCandidates("amakhov@example.com")).toEqual(["amakhov"]);
    expect(usernameCandidates("")).toEqual([]);
  });
});
