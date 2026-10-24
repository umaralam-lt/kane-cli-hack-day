"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { teamSyncEnabled } from "@/lib/testmu-provision";
import { memberActor, requirePersonalMember, requireRole } from "@/server/auth";
import { AppError, formObject, runAction, type ActionResult } from "@/server/core";
import { syncTestmuTeam, teamSyncStatus, type TeamSyncResult } from "@/server/testmu";
import {
  advanceTeamState,
  createInvite,
  createTeam,
  getTeamInfo,
  joinTeam,
  leaveTeam,
  organizerOverride,
  removeMember,
  revokeInvite,
  transferCaptain,
  confirmFinalTeam,
  updateTeamSettings,
  type ActingMember,
  type CreatedInvite,
} from "@/server/teams";

// Thin wrappers: every rule (who, when, how many) lives in src/server/teams.ts.
// Event-day flow: every team action needs a personal sign-in; the hub opens
// from that same personal session (there is no team cookie or team password).

/** The personally signed-in member, as the actor for team changes. */
async function actingMember(): Promise<ActingMember> {
  const member = await requirePersonalMember();
  return { member, actor: memberActor(member) };
}

export type TeamFormState = ActionResult<unknown> | null;
export type InviteFormState = ActionResult<CreatedInvite> | null;

async function teamId(slug: string) {
  const t = await getTeamInfo({ slug });
  if (!t) throw new AppError("NOT_FOUND", { userMessage: "Team not found." });
  return t.id;
}

export async function createTeamAction(_prev: TeamFormState, form: FormData): Promise<TeamFormState> {
  return runAction(async () => {
    const who = await actingMember();
    await createTeam(who, formObject(form));
    redirect("/team?created=1");
  });
}

export async function joinTeamAction(_prev: TeamFormState, form: FormData): Promise<TeamFormState> {
  return runAction(async () => {
    await joinTeam(await actingMember(), formObject(form));
    // Land on the team page: who's on it, then "Next: activate".
    redirect("/team?joined=1");
  });
}

export async function createInviteAction(slug: string, _prev: InviteFormState, form: FormData): Promise<InviteFormState> {
  return runAction(async () => {
    const out = await createInvite(await actingMember(), await teamId(slug), formObject(form));
    refresh();
    return { data: out, receipt: out.receipt };
  });
}

export async function revokeInviteAction(slug: string, inviteId: number) {
  const out = await runAction(async () => revokeInvite(await actingMember(), await teamId(slug), inviteId));
  refresh();
  return out;
}

export async function updateSettingsAction(slug: string, _prev: TeamFormState, form: FormData): Promise<TeamFormState> {
  return runAction(async () => {
    const receipt = await updateTeamSettings(await actingMember(), await teamId(slug), formObject(form));
    refresh();
    return { data: null, receipt };
  });
}

/** "This is our final team": lock the roster, sync it to TestMu AI once, then on to activation. */
export async function confirmFinalTeamAction(slug: string, _prev: TeamFormState, form: FormData): Promise<TeamFormState> {
  const r = await runAction(async () => {
    const who = await actingMember();
    const id = await teamId(slug);
    return { who, id, receipt: await confirmFinalTeam(who, id) };
  });
  if (!r.ok) return r;
  // Our lock is committed. The TestMu AI sync runs after it and never undoes it.
  if (teamSyncEnabled()) {
    const sync = await runAction(() => syncTestmuTeam(r.data.who, r.data.id, String(form.get("testmu_password") ?? "")));
    const left = (await teamSyncStatus(r.data.id)).some((s) => !s.done);
    if (!sync.ok || left) redirect("/team?testmu_sync=1#testmu-sync");
  }
  redirect("/activate");
}

export async function removeMemberAction(slug: string, memberId: number): Promise<TeamFormState> {
  return runAction(async () => {
    const receipt = await removeMember(await actingMember(), await teamId(slug), memberId);
    refresh();
    return { data: null, receipt };
  });
}

export async function transferCaptainAction(slug: string, memberId: number): Promise<TeamFormState> {
  return runAction(async () => {
    const receipt = await transferCaptain(await actingMember(), await teamId(slug), memberId);
    refresh();
    return { data: null, receipt };
  });
}

export async function advanceStateAction(slug: string, to: "formed" | "active"): Promise<TeamFormState> {
  return runAction(async () => {
    const receipt = await advanceTeamState(await actingMember(), await teamId(slug), to);
    refresh();
    return { data: null, receipt };
  });
}

export async function leaveTeamAction(_prev: TeamFormState, form: FormData): Promise<TeamFormState> {
  return runAction(async () => {
    if (form.get("confirm") !== "on") throw new AppError("VALIDATION_FAILED", { userMessage: "Tick the box to confirm you're leaving." });
    const who = await actingMember();
    await leaveTeam(who);
    redirect("/team");
  });
}

export async function overrideAction(slug: string, _prev: TeamFormState, form: FormData): Promise<TeamFormState> {
  return runAction(async () => {
    const staff = await requireRole("organizer");
    const receipt = await organizerOverride(staff, await teamId(slug), formObject(form));
    refresh();
    return { data: null, receipt };
  });
}

export type SyncFormState = ActionResult<TeamSyncResult> | null;

/** Captain retries the TestMu AI team sync for teammates not in it yet. The password is used once, never kept. */
export async function retryTestmuSyncAction(slug: string, _prev: SyncFormState, form: FormData): Promise<SyncFormState> {
  return runAction(async () => {
    const out = await syncTestmuTeam(await actingMember(), await teamId(slug), String(form.get("testmu_password") ?? ""));
    refresh();
    return out;
  });
}
