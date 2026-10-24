#!/usr/bin/env node
// A local stand-in for TestMu AI's Hack Day APIs, shaped exactly like their contract
// (hack-day-2026-fe-api.json), so tests and a local app never call backend.lambdatest.com.
//
//   POST /api/trials/hack-day/claim        {email, password, name?, linkedin?, twitter?, github?, source?, page_url?}
//   POST /api/trials/hack-day/team/invite  {email, password, member_email}
//
// Accounts, orgs (one per signup, its claimer the admin) and pending invites are kept in
// memory, so every code comes out of real state: SIGNEDUP, JOINED_TEAM, ALREADY_CLAIMED,
// INVALID_CREDENTIALS, INELIGIBLE, INVALID_REQUEST (422), MEMBER_ADDED, MEMBER_INVITED,
// ALREADY_IN_TEAM, NOT_TEAM_LEAD, NOT_HACK_DAY_ORG, MEMBER_IN_ANOTHER_TEAM, ALREADY_INVITED,
// TEAM_FULL, and 429 + Retry-After past 30/min per IP or 5/min per email.
// The rest (ALREADY_ACTIVE, FAILED, REGION_NOT_SUPPORTED, CAMPAIGN_ENDED, or any 429) are forced.
//
// Test-only controls:
//   POST /__mock/account {email, password, eligible?, claimed?}   an existing TestMu AI account
//   POST /__mock/force {api: "claim"|"invite", email?, status, body?, retry_after?}   answer the next matching call
//   GET  /__mock/calls                                            every call received (path, body, headers)
//   POST /__mock/reset                                            forget everything
//
//   node tests/support/testmu-mock.mjs [--port 3105] [--ip-limit 30] [--email-limit 5]
// Prints "testmu-mock listening on <port>" once it is ready.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const CLAIM = "/api/trials/hack-day/claim";
const INVITE = "/api/trials/hack-day/team/invite";
const TEAM_MAX = 4;
const WINDOW_MS = 60_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createTestmuMock({ ipLimit = 30, emailLimit = 5, idBase = 1_000_000 } = {}) {
  const state = fresh();

  function fresh() {
    return { accounts: new Map(), orgs: new Map(), invites: new Map(), forced: [], calls: [], hits: new Map(), nextId: idBase };
  }

  function reset() {
    Object.assign(state, fresh());
  }

  function addAccount({ email, password, eligible = true, claimed = false }) {
    const id = state.nextId++;
    const org = state.nextId++;
    const acc = { email: email.toLowerCase(), password, eligible, claimed, user_id: id, username: `tm${id}`, token: `tok_${randomBytes(12).toString("hex")}`, org, admin: true };
    state.accounts.set(acc.email, acc);
    state.orgs.set(org, { lead: acc.email, members: new Set([acc.email]) });
    return acc;
  }

  /** Over the per-IP or per-email window: the seconds to wait, else 0. */
  function limited(key, limit) {
    const now = Date.now();
    const w = state.hits.get(key);
    const cur = w && now - w.start < WINDOW_MS ? w : { start: now, n: 0 };
    cur.n += 1;
    state.hits.set(key, cur);
    return cur.n > limit ? Math.ceil((cur.start + WINDOW_MS - now) / 1000) : 0;
  }

  /** Answer the next matching call with `status` (and `body`, `retry_after`) instead of the real logic. */
  function force(f) {
    return state.forced.push(f);
  }

  function takeForced(api, email) {
    const i = state.forced.findIndex((f) => f.api === api && (!f.email || f.email.toLowerCase() === email));
    return i < 0 ? null : state.forced.splice(i, 1)[0];
  }

  const creds = (a, code, message) => ({ status: 200, body: { code, message, user_id: a.user_id, username: a.username, access_token: a.token, organization_id: a.org } });

  function validate(b, rules) {
    const errors = {};
    for (const [field, rule] of Object.entries(rules)) {
      const v = b[field];
      if (v === undefined || v === null || v === "") {
        if (rule.required) errors[field] = [`The ${field} field is required.`];
        continue;
      }
      if (typeof v !== "string") errors[field] = [`The ${field} must be a string.`];
      else if (rule.min && v.length < rule.min) errors[field] = [`The ${field} must be at least ${rule.min} characters.`];
      else if (rule.max && v.length > rule.max) errors[field] = [`The ${field} may not be greater than ${rule.max} characters.`];
      else if (rule.email && !EMAIL_RE.test(v)) errors[field] = [`The ${field} must be a valid email address.`];
      else if (rule.url && !/^https?:\/\/\S+$/.test(v)) errors[field] = [`The ${field} format is invalid.`];
    }
    return Object.keys(errors).length ? { status: 422, body: { code: "INVALID_REQUEST", errors } } : null;
  }

  function claim(b) {
    const bad = validate(b, {
      email: { required: true, email: true, max: 200 },
      password: { required: true, min: 8, max: 255 },
      name: { max: 255 },
      linkedin: { max: 255 },
      twitter: { max: 255 },
      github: { max: 255 },
      source: { max: 100 },
      page_url: { url: true, max: 2048 },
    });
    if (bad) return bad;
    const email = b.email.toLowerCase();
    const acc = state.accounts.get(email);
    if (acc) {
      if (!acc.eligible) return { status: 200, body: { code: "INELIGIBLE", message: "This account is not eligible for the trial." } };
      if (acc.password !== b.password) return { status: 401, body: { code: "INVALID_CREDENTIALS", message: "Incorrect password for this account." } };
      if (acc.claimed) return creds(acc, "ALREADY_CLAIMED", "Trial already claimed for this organization.");
      acc.claimed = true;
      return creds(acc, "SIGNEDUP", "Trial activated.");
    }
    const invitedTo = state.invites.get(email);
    const created = addAccount({ email, password: b.password, claimed: true });
    if (invitedTo) {
      state.orgs.delete(created.org);
      created.org = invitedTo;
      created.admin = false;
      state.orgs.get(invitedTo).members.add(email);
      state.invites.delete(email);
      return creds(created, "JOINED_TEAM", "Account created and added to your team.");
    }
    return creds(created, "SIGNEDUP", "Trial activated.");
  }

  function invite(b) {
    const bad = validate(b, { email: { required: true, email: true }, password: { required: true }, member_email: { required: true, email: true } });
    if (bad) return bad;
    const leadEmail = b.email.toLowerCase();
    const memberEmail = b.member_email.toLowerCase();
    if (leadEmail === memberEmail) return { status: 422, body: { code: "INVALID_REQUEST", errors: { member_email: ["The member email and email must be different."] } } };
    const lead = state.accounts.get(leadEmail);
    if (!lead || lead.password !== b.password) return { status: 401, body: { code: "INVALID_CREDENTIALS", message: "Incorrect email or password." } };
    if (!lead.admin || !lead.claimed) return { status: 403, body: { code: "NOT_TEAM_LEAD", message: "Only the admin of a Hack Day 2026 account can add team members." } };
    const org = state.orgs.get(lead.org);
    const pending = [...state.invites.values()].filter((o) => o === lead.org).length;
    const full = org.members.size + pending >= TEAM_MAX;
    const member = state.accounts.get(memberEmail);
    if (member) {
      if (!member.eligible) return { status: 403, body: { code: "INELIGIBLE", message: "This account is not eligible to join a team." } };
      if (!member.claimed) return { status: 403, body: { code: "NOT_HACK_DAY_ORG", message: "This member is not a Hack Day 2026 participant." } };
      const ok = { member_user_id: member.user_id, member_email: memberEmail, organization_id: lead.org };
      if (member.org === lead.org) return { status: 200, body: { code: "ALREADY_IN_TEAM", message: "This member is already in your team.", ...ok } };
      if (state.orgs.get(member.org)?.members.size > 1) return { status: 409, body: { code: "MEMBER_IN_ANOTHER_TEAM", message: "This member already belongs to another team." } };
      if (full) return { status: 409, body: { code: "TEAM_FULL", message: "Your team already has 4 members (including pending invites)." } };
      state.orgs.delete(member.org);
      member.org = lead.org;
      member.admin = false;
      org.members.add(memberEmail);
      return { status: 200, body: { code: "MEMBER_ADDED", message: "Member added to your team.", ...ok } };
    }
    const invitedTo = state.invites.get(memberEmail);
    if (invitedTo && invitedTo !== lead.org) return { status: 409, body: { code: "ALREADY_INVITED", message: "This email has already been invited to another team." } };
    if (!invitedTo && full) return { status: 409, body: { code: "TEAM_FULL", message: "Your team already has 4 members (including pending invites)." } };
    state.invites.set(memberEmail, lead.org);
    return { status: 200, body: { code: "MEMBER_INVITED", message: "Invite recorded. They will join your team when they sign up.", organization_id: lead.org } };
  }

  function answer(path, b, ip) {
    const api = path === CLAIM ? "claim" : "invite";
    const email = typeof b.email === "string" ? b.email.toLowerCase() : "";
    const forced = takeForced(api, api === "invite" && typeof b.member_email === "string" ? b.member_email.toLowerCase() : email);
    if (forced) return { status: forced.status, body: forced.body ?? (forced.status === 429 ? { message: "Too Many Attempts." } : {}), retryAfter: forced.retry_after ?? null };
    const wait = limited(`ip:${ip}`, ipLimit) || (email ? limited(`email:${email}`, emailLimit) : 0);
    if (wait) return { status: 429, body: { message: "Too Many Attempts." }, retryAfter: wait };
    return api === "claim" ? claim(b) : invite(b);
  }

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://mock");
      const send = (status, body, extra = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...extra });
        res.end(JSON.stringify(body));
      };
      let b = {};
      try {
        b = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { message: "Malformed JSON." });
      }
      if (url.pathname === "/__mock/account" && req.method === "POST") return send(200, addAccount(b));
      if (url.pathname === "/__mock/force" && req.method === "POST") return send(200, { queued: force(b) });
      if (url.pathname === "/__mock/calls") return send(200, state.calls);
      if (url.pathname === "/__mock/reset" && req.method === "POST") return send(200, (reset(), { ok: true }));
      if (req.method !== "POST" || (url.pathname !== CLAIM && url.pathname !== INVITE)) return send(404, { message: "Not found." });
      state.calls.push({ path: url.pathname, body: b, headers: { authorization: req.headers.authorization ?? null, "content-type": req.headers["content-type"] ?? null } });
      const out = answer(url.pathname, b, req.socket.remoteAddress);
      send(out.status, out.body, out.retryAfter ? { "retry-after": String(out.retryAfter) } : {});
    });
  });

  return { server, state, reset, addAccount, force, CLAIM, INVITE };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const port = Number(arg("port", 3105));
  const mock = createTestmuMock({ ipLimit: Number(arg("ip-limit", 30)), emailLimit: Number(arg("email-limit", 5)) });
  mock.server.listen(port, "127.0.0.1", () => console.log(`testmu-mock listening on ${port}`));
}
