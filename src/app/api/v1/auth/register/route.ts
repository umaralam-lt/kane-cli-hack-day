import { isRegistrationOpen } from "@/lib/teams";
import { activationEnabled } from "@/lib/testmu-provision";
import { getMemberById, getPersonalMember } from "@/server/auth";
import { AppError, envelopeResponse, runAction, siteUrl } from "@/server/core";
import { flowState, setTeamChoice, submitProfile } from "@/server/flow";
import { clientKey, enforceRateLimit } from "@/server/ratelimit";
import { activateTestmu } from "@/server/testmu";
import { readBody } from "../../teams/body";

// POST /api/v1/auth/register: save the profile and activate TestMu AI; returns the access key once.
// No TestMu key needed: this is where it comes from.
//   { name, email (the Luma one), linkedin, x, github?, password (8+), looking?: "yes",
//     proof_password? | proof_code? (only when the email already has an account),
//     testmu_password? (the TestMu AI password, when it differs from `password`) }
// The same profile as /register. Saves it, then activates the person on TestMu AI
// with it and their TestMu AI password: testmu_password, else password, else
// proof_password. The password is passed on, never stored. TestMu answers with their
// username + access key, returned here ONCE as data.testmu. Send them as
// X-TestMu-Username / X-TestMu-Access-Key on every call after. The key isn't stored (only a fingerprint).
// 409 needs_proof: the email has an account; resend with proof_password or proof_code.
// needs_action with data.testmu_error.reason "wrong_password": the email already has a
// TestMu AI account with another password. Resend with proof_password + testmu_password.

export async function POST(req: Request) {
  return envelopeResponse<RegisterData>(async () => {
    await enforceRateLimit(`api-register:${await clientKey(req)}`, { limit: 10, windowSec: 300 });
    const viewer = await getPersonalMember();
    if (!viewer && !(await isRegistrationOpen())) throw new AppError("DEADLINE_PASSED", { userMessage: "Registration is closed. Ask at the help desk." });
    const body = await readBody(req);
    const r = await submitProfile({ ...body, looking: body.looking === true || body.looking === "yes" ? "yes" : undefined }, viewer);
    if (r.kind === "needs_proof") {
      throw new AppError("CONFLICT", { userMessage: "That email already has an account. Send proof_password (its password) or proof_code (a one-time code from the desk)." });
    }
    const member = await getMemberById(r.memberId);
    if (member) await setTeamChoice(member, r.looking, { fromProfile: true });
    const activation = activationEnabled() ? await runAction(() => activateTestmu(r.memberId, { password: testmuPasswordOf(body) })) : null;
    const next = (await flowState(r.memberId)).next;
    if (activation && !activation.ok) {
      const details = (activation.error.details ?? {}) as { reason?: string; testmu_code?: string | null; retry_after_sec?: number };
      return {
        status: "needs_action",
        message: `Profile saved, but TestMu AI activation failed: ${activation.error.message}`,
        data: {
          member_id: r.memberId,
          created: r.created,
          testmu: null,
          testmu_error: { code: activation.error.code, reason: details.reason ?? null, testmu_code: details.testmu_code ?? null, retry_after_sec: details.retry_after_sec ?? null },
          next: siteUrl(next),
        },
        actions: [{ id: "retry_activation", label: "Resend with testmu_password (your TestMu AI password), or retry on /register", requires_human_confirmation: false, href: siteUrl("/register?testmu=failed") }],
        warnings: [activation.error.code],
      };
    }
    const t = activation?.ok ? activation.data : null;
    return {
      message: t ? `Profile saved and TestMu AI activated as ${t.username}. Save the access key now: it is shown only once.` : "Profile saved.",
      data: { member_id: r.memberId, created: r.created, testmu: t ? { username: t.username, access_key: t.access_key } : null, next: siteUrl(next) },
      fallbackText: t ? `TestMu AI username: ${t.username}\nAccess key: ${t.access_key}\nSend both as X-TestMu-Username / X-TestMu-Access-Key from now on.` : "Profile saved.",
      warnings: t ? [] : ["TestMu AI activation isn't configured on this deployment yet."],
    };
  });
}

/** The TestMu AI password in this body: testmu_password, else the site password, else the proof one. */
function testmuPasswordOf(body: Record<string, unknown>) {
  return [body.testmu_password, body.password, body.proof_password].find((v): v is string => typeof v === "string" && v.length > 0) ?? "";
}

type RegisterData = {
  member_id: number;
  created: boolean;
  testmu: { username: string; access_key: string } | null;
  testmu_error?: { code: string; reason: string | null; testmu_code: string | null; retry_after_sec: number | null };
  next: string;
};
