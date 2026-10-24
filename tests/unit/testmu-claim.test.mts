// TestMu AI Hack Day claim and team invite, without a network: the request we send,
// the code → result mapping for every answer in the contract, Retry-After, and the stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STUB_TESTMU_PASSWORD,
  claimResultFrom,
  inviteResultFrom,
  inviteTestmuMember,
  provisionTestmuAccount,
  retryAfterSeconds,
  teamSyncEnabled,
  type ProvisionProfile,
} from "../../src/lib/testmu-provision.ts";

const creds = { user_id: 1234567, username: "janedoe", access_token: "tok-1", organization_id: 7654321 };
const profile: ProvisionProfile = {
  name: "Jane Doe",
  email: "Jane@Example.com",
  password: "correct-horse-1",
  linkedin: "https://www.linkedin.com/in/jane-doe",
  x: "janedoe",
  github: "janedoe",
  external_id: "member:7",
  page_url: "https://kaneclihack.sh/register",
};

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    process.env = saved;
  }
}

/** Swap fetch for one call: record what was sent, answer with `status`/`body`/`headers`. */
async function withFetch<T>(answer: { status: number; body: unknown; headers?: Record<string, string> }, fn: () => Promise<T>) {
  const sent: { url: string; init: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json", ...answer.headers } });
  }) as typeof fetch;
  try {
    return { out: await fn(), sent };
  } finally {
    globalThis.fetch = real;
  }
}

test("the four success codes come back ok with the access token as the key and the organization", () => {
  for (const code of ["SIGNEDUP", "JOINED_TEAM", "ALREADY_CLAIMED", "ALREADY_ACTIVE"]) {
    const r = claimResultFrom(200, { code, message: "m", ...creds }, null);
    assert.deepEqual(r, { ok: true, username: "janedoe", accessKey: "tok-1", email: null, organizationId: 7654321, code });
  }
});

test("a success code without credentials is unavailable, never a key", () => {
  const r = claimResultFrom(200, { code: "SIGNEDUP", message: "Trial activated." }, null);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === "unavailable" && r.detail.includes("without username/access_token"));
});

test("INELIGIBLE is refused even though it is HTTP 200, with TestMu's message", () => {
  const r = claimResultFrom(200, { code: "INELIGIBLE", message: "An account with this email already exists." }, null);
  assert.ok(!r.ok && r.reason === "rejected" && r.code === "INELIGIBLE" && r.message === "An account with this email already exists.");
});

test("INVALID_CREDENTIALS (401) is its own reason: wrong_password", () => {
  const r = claimResultFrom(401, { code: "INVALID_CREDENTIALS", message: "Incorrect password for this account." }, null);
  assert.ok(!r.ok && r.reason === "wrong_password" && r.code === "INVALID_CREDENTIALS");
});

test("FAILED (502) is unavailable and retryable", () => {
  const r = claimResultFrom(502, { code: "FAILED", message: "Could not activate trial, please retry." }, null);
  assert.ok(!r.ok && r.reason === "unavailable" && r.code === "FAILED" && r.retryAfter === null);
});

test("INVALID_REQUEST (422) is refused with field errors under our names: twitter → x", () => {
  const r = claimResultFrom(422, { code: "INVALID_REQUEST", errors: { password: ["The password must be at least 8 characters."], twitter: ["The twitter may not be greater than 255 characters."] } }, null);
  assert.ok(!r.ok && r.reason === "rejected");
  assert.deepEqual(!r.ok && r.fieldErrors, { password: "The password must be at least 8 characters.", x: "The twitter may not be greater than 255 characters." });
  assert.ok(!r.ok && r.message?.includes("at least 8 characters"));
});

test("REGION_NOT_SUPPORTED and CAMPAIGN_ENDED are refused", () => {
  for (const [status, code] of [[403, "REGION_NOT_SUPPORTED"], [410, "CAMPAIGN_ENDED"]] as const) {
    const r = claimResultFrom(status, { code, message: "m" }, null);
    assert.ok(!r.ok && r.reason === "rejected" && r.code === code);
  }
});

test("429 is unavailable with retry_after in seconds", () => {
  const r = claimResultFrom(429, { message: "Too Many Attempts." }, "42");
  assert.ok(!r.ok && r.reason === "unavailable" && r.code === "RATE_LIMITED" && r.retryAfter === 42);
});

test("anything else is unavailable: unknown code, 5xx, malformed", () => {
  for (const [status, body] of [[200, { code: "SOMETHING_NEW", ...creds }], [500, null], [200, null], [404, { message: "Not found" }]] as const) {
    const r = claimResultFrom(status, body, null);
    assert.ok(!r.ok && r.reason === "unavailable", `${status} ${JSON.stringify(body)}`);
  }
});

test("other answer shapes (no code, access_key) still activate", () => {
  const r = claimResultFrom(200, { username: "alex", access_key: "k1" }, null);
  assert.deepEqual(r, { ok: true, username: "alex", accessKey: "k1", email: null, organizationId: null, code: null });
});

test("Retry-After: seconds, an HTTP date, or a default", () => {
  assert.equal(retryAfterSeconds("7"), 7);
  assert.equal(retryAfterSeconds("0.2"), 1);
  const at = retryAfterSeconds(new Date(Date.now() + 30_000).toUTCString());
  assert.ok(at >= 29 && at <= 31, String(at));
  assert.equal(retryAfterSeconds(null), 60);
  assert.equal(retryAfterSeconds("soon"), 60);
});

test("invite codes: added, invited and already-in-team are done, every refusal keeps its code", () => {
  for (const code of ["MEMBER_ADDED", "MEMBER_INVITED", "ALREADY_IN_TEAM"]) assert.equal(inviteResultFrom(200, { code, organization_id: 7654321 }, null).done, true);
  for (const [status, code] of [[401, "INVALID_CREDENTIALS"], [403, "NOT_TEAM_LEAD"], [403, "INELIGIBLE"], [403, "NOT_HACK_DAY_ORG"], [409, "MEMBER_IN_ANOTHER_TEAM"], [409, "ALREADY_INVITED"], [409, "TEAM_FULL"], [422, "INVALID_REQUEST"], [403, "REGION_NOT_SUPPORTED"], [410, "CAMPAIGN_ENDED"]] as const) {
    const r = inviteResultFrom(status, { code, message: "m" }, null);
    assert.equal(r.code, code);
    assert.equal(r.done, false);
  }
  assert.deepEqual(inviteResultFrom(429, { message: "Too Many Attempts." }, "9"), { code: "RATE_LIMITED", done: false, message: "Too Many Attempts.", organizationId: null, retryAfter: 9 });
  assert.equal(inviteResultFrom(503, null, null).code, "UNAVAILABLE");
  assert.equal(inviteResultFrom(200, { code: "MEMBER_ADDED", organization_id: 5 }, null).organizationId, 5);
});

test("the claim request carries exactly the contract's fields", async () => {
  const { out, sent } = await withEnv({ TESTMU_PROVISION_URL: "http://mock.test/api/trials/hack-day/claim", TESTMU_PROVISION_TOKEN: undefined }, () =>
    withFetch({ status: 200, body: { code: "SIGNEDUP", ...creds } }, () => provisionTestmuAccount(profile)),
  );
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.method, "POST");
  const body = JSON.parse(String(sent[0].init.body));
  assert.deepEqual(body, {
    email: "jane@example.com",
    password: "correct-horse-1",
    name: "Jane Doe",
    linkedin: "https://www.linkedin.com/in/jane-doe",
    twitter: "@janedoe",
    github: "janedoe",
    source: "kaneclihack.sh",
    page_url: "https://kaneclihack.sh/register",
  });
  assert.equal((sent[0].init.headers as Record<string, string>).authorization, undefined);
});

test("empty optional fields are left out; the Bearer token is sent only when set", async () => {
  const { sent } = await withEnv({ TESTMU_PROVISION_URL: "http://mock.test/claim", TESTMU_PROVISION_TOKEN: "srv-token" }, () =>
    withFetch({ status: 200, body: { code: "SIGNEDUP", ...creds } }, () => provisionTestmuAccount({ ...profile, linkedin: null, x: null, github: null })),
  );
  const body = JSON.parse(String(sent[0].init.body));
  assert.deepEqual(Object.keys(body).sort(), ["email", "name", "page_url", "password", "source"]);
  assert.equal((sent[0].init.headers as Record<string, string>).authorization, "Bearer srv-token");
});

test("a 429 from the claim API reads Retry-After from the response header", async () => {
  const { out } = await withEnv({ TESTMU_PROVISION_URL: "http://mock.test/claim" }, () =>
    withFetch({ status: 429, body: { message: "Too Many Attempts." }, headers: { "retry-after": "13" } }, () => provisionTestmuAccount(profile)),
  );
  assert.ok(!out.ok && out.reason === "unavailable" && out.retryAfter === 13);
});

test("the invite request carries exactly email, password and member_email, and no Bearer", async () => {
  const { out, sent } = await withEnv({ TESTMU_TEAM_INVITE_URL: "http://mock.test/api/trials/hack-day/team/invite", TESTMU_PROVISION_TOKEN: "srv-token" }, () =>
    withFetch({ status: 200, body: { code: "MEMBER_INVITED", organization_id: 1 } }, () => inviteTestmuMember({ email: "Lead@X.io", password: "lead-password", member_email: "Member@X.io" })),
  );
  assert.equal(out.done, true);
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), { email: "lead@x.io", password: "lead-password", member_email: "member@x.io" });
  assert.equal((sent[0].init.headers as Record<string, string>).authorization, undefined);
});

test("a network failure is unavailable for both APIs", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    await withEnv({ TESTMU_PROVISION_URL: "http://mock.test/claim", TESTMU_TEAM_INVITE_URL: "http://mock.test/invite" }, async () => {
      const c = await provisionTestmuAccount(profile);
      assert.ok(!c.ok && c.reason === "unavailable" && c.detail === "TypeError");
      assert.equal((await inviteTestmuMember({ email: "a@x.io", password: "p", member_email: "b@x.io" })).code, "UNAVAILABLE");
    });
  } finally {
    globalThis.fetch = real;
  }
});

test("the stub simulates each code from a +testmu-<code> email tag", async () => {
  await withEnv({ TESTMU_PROVISION_URL: undefined, TESTMU_TEAM_INVITE_URL: undefined, VERCEL_ENV: "preview", HACKOS_ENV: undefined, TESTMU_PROVISION_STUB: undefined }, async () => {
    const ok = await provisionTestmuAccount(profile);
    assert.ok(ok.ok && ok.code === "SIGNEDUP" && ok.accessKey.startsWith("stub_") && ok.organizationId === 7_000_007);
    const tagged = (code: string) => provisionTestmuAccount({ ...profile, email: `jane+testmu-${code}@example.com` });
    const expected: Record<string, string> = { ineligible: "rejected", "invalid-credentials": "wrong_password", failed: "unavailable", invalid_request: "rejected", "region-not-supported": "rejected", "campaign-ended": "rejected", "rate-limited": "unavailable" };
    for (const [code, reason] of Object.entries(expected)) {
      const r = await tagged(code);
      assert.ok(!r.ok && r.reason === reason, code);
    }
    for (const code of ["joined-team", "already-claimed", "already-active"]) assert.equal((await tagged(code)).ok, true, code);
    // The wrong-password stub accepts STUB_TESTMU_PASSWORD, so the retry can be clicked through.
    const retried = await provisionTestmuAccount({ ...profile, email: "jane+testmu-invalid-credentials@example.com", password: STUB_TESTMU_PASSWORD });
    assert.equal(retried.ok, true);
    const inv = (code: string) => inviteTestmuMember({ email: "lead@x.io", password: "p", member_email: `bob+testmu-${code}@x.io` });
    assert.equal((await inv("not-hack-day-org")).code, "NOT_HACK_DAY_ORG");
    assert.equal((await inv("rate-limited")).retryAfter, 30);
    assert.equal((await inviteTestmuMember({ email: "lead@x.io", password: "p", member_email: "bob@x.io" })).code, "MEMBER_ADDED");
  });
});

test("team sync runs on previews, and in production only once the invite URL is set", async () => {
  await withEnv({ VERCEL_ENV: "production", TESTMU_TEAM_INVITE_URL: undefined }, async () => {
    assert.equal(teamSyncEnabled(), false);
    const r = await inviteTestmuMember({ email: "a@x.io", password: "p", member_email: "b@x.io" });
    assert.equal(r.code, "UNAVAILABLE");
    process.env.TESTMU_TEAM_INVITE_URL = "https://backend.example/invite";
    assert.equal(teamSyncEnabled(), true);
    process.env.VERCEL_ENV = "preview";
    delete process.env.TESTMU_TEAM_INVITE_URL;
    assert.equal(teamSyncEnabled(), true);
  });
});
