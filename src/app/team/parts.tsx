"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { FormError, Label, SubmitButton, Toggle, inputCls } from "@/components/forms/fields";
import CopyField from "@/components/ui/CopyField";
import TagInput from "@/components/forms/TagInput";
import { SKILL_SUGGESTIONS } from "@/data/profile-tags";
import { slugify } from "@/lib/slug";
import { suggestTeamName } from "@/data/team-names";
import {
  advanceStateAction,
  confirmFinalTeamAction,
  createInviteAction,
  createTeamAction,
  joinTeamAction,
  leaveTeamAction,
  overrideAction,
  removeMemberAction,
  retryTestmuSyncAction,
  revokeInviteAction,
  transferCaptainAction,
  updateSettingsAction,
  type InviteFormState,
  type SyncFormState,
  type TeamFormState,
} from "./actions";
import { ActionNote, dangerBtn, smallBtn } from "./ui";
import { apiFetch } from "@/lib/api-client";

export function CreateTeamForm({ idempotencyKey }: { idempotencyKey: string }) {
  const [state, action] = useActionState<TeamFormState, FormData>(createTeamAction, null);
  const [solo, setSolo] = useState(false);
  const [name, setName] = useState("");
  // Off by default: a team that's already complete shouldn't show up as recruiting.
  const [recruiting, setRecruiting] = useState(false);
  const slug = slugify(name);
  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <div>
        <Label htmlFor="team-name" hint="Becomes your page address">
          {solo ? "Project name" : "Team name"}
        </Label>
        <div className="flex gap-2">
          <input id="team-name" name="name" required maxLength={60} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} aria-describedby="team-slug" className={inputCls} placeholder="Release Gate Crew" />
          <button
            type="button"
            onClick={() => setName((n) => suggestTeamName(n))}
            className="inline-flex min-h-11 shrink-0 items-center gap-2 border border-hairline px-4 font-plex text-sm text-bright transition-colors hover:border-lime hover:text-lime"
          >
            <span aria-hidden="true">✦</span> Suggest a name
          </button>
        </div>
        <p id="team-slug" className="mt-2 font-plex text-sm text-lightgray" aria-live="polite">
          {slug ? (
            <>
              Your team page: <span className="text-bright">/t/{slug}</span>
            </>
          ) : name.trim() ? (
            <span className="text-danger">Use some letters or numbers in the name.</span>
          ) : (
            "Your team page address appears here as you type."
          )}
        </p>
      </div>
      {!solo && (
        <div className="space-y-4 border-2 border-hairline p-5 has-[input[name=recruiting_open]:checked]:border-lime has-[input[name=recruiting_open]:checked]:bg-lime-deep">
          <label className="flex cursor-pointer items-start gap-4">
            <input type="checkbox" name="recruiting_open" checked={recruiting} onChange={(e) => setRecruiting(e.target.checked)} className="mt-1 h-6 w-6 shrink-0 accent-[var(--lime)]" />
            <span>
              <span className="block font-display text-xl text-bright">Looking for more teammates?</span>
              <span className="mt-1 block font-plex text-sm leading-relaxed text-lightgray">
                Your team shows up under “Teams with open seats” in matchmaking, and you can browse people looking for a team and invite them. Up to 4 people per team.
              </span>
            </span>
          </label>
          {recruiting && (
            <div>
              <Label htmlFor="team-seeking" hint="Optional">
                Skills you need
              </Label>
              <TagInput id="team-seeking" name="seeking_skills" defaultValue="" options={SKILL_SUGGESTIONS} placeholder="Start typing: fr… → frontend" />
            </div>
          )}
        </div>
      )}
      <details className="group border border-dashed border-hairline" open={solo || undefined}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-plex text-base text-bright marker:hidden hover:text-lime">
          <span>Are you participating solo?</span>
          <span aria-hidden="true" className="text-lightgray transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="space-y-3 border-t border-dashed border-hairline px-4 py-4">
          <p className="font-plex text-sm leading-relaxed text-lightgray">You can build on your own: same challenge, same judging. If someone joins you later with an invite code, you become a team.</p>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 font-plex text-sm text-bright">
            <input type="checkbox" name="solo" checked={solo} onChange={(e) => setSolo(e.target.checked)} className="h-5 w-5 accent-[var(--lime)]" />
            Yes, I’m going solo
          </label>
        </div>
      </details>
      <ActionNote state={state} />
      <SubmitButton pending="Creating…" className="min-h-12 text-base">
        {solo ? "Start solo →" : "Create team · I’m the captain →"}
      </SubmitButton>
    </form>
  );
}

/** Join with an invite code from a teammate: type it (or arrive with ?code=) and press Join. */
export function JoinByCodeForm({ code, idempotencyKey, teamName }: { code: string; idempotencyKey: string; teamName: string | null }) {
  const [state, action] = useActionState<TeamFormState, FormData>(joinTeamAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <div>
        <Label htmlFor="join-code" hint="From your captain">
          Invite code
        </Label>
        <input id="join-code" name="code" required defaultValue={code} autoComplete="off" placeholder="XXXX-XXXX" className={`${inputCls} uppercase tracking-[0.2em]`} />
      </div>
      {/* Pressing "Join team" is the confirmation the server asks for. */}
      <input type="hidden" name="confirm" value="on" />
      <ActionNote state={state} />
      <SubmitButton pending="Joining…" className="min-h-11">
        {teamName ? `Join ${teamName} →` : "Join team →"}
      </SubmitButton>
    </form>
  );
}

export function InviteForm({ slug }: { slug: string }) {
  const [state, action] = useActionState<InviteFormState, FormData>(createInviteAction.bind(null, slug), null);
  const invite = state?.ok ? state.data : null;
  return (
    <div className="space-y-4">
      <form action={action}>
        {/* Good for the whole day; each code works for one person. */}
        <input type="hidden" name="hours" value="24" />
        <SubmitButton pending="Creating…" className="min-h-11 text-base">
          Create an invite code
        </SubmitButton>
      </form>
      {state && !state.ok && <ActionNote state={state} />}
      {invite && <InviteReveal code={invite.code} path={invite.joinPath} expiresAt={invite.expiresAt} />}
    </div>
  );
}

function InviteReveal({ code, path, expiresAt }: { code: string; path: string; expiresAt: string }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <div className="brackets border border-lime bg-lime-deep p-4" role="status">
      <p className="font-pixel text-[10px] uppercase tracking-[0.2em] text-lime">Invite code · shown once</p>
      <p className="mt-2 font-dots text-4xl leading-none font-black text-bright">{code}</p>
      <p className="mt-2 font-plex text-xs text-lightgray">
        One use. Expires {new Date(expiresAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}. Send it privately; whoever uses it joins your team.
      </p>
      <CopyField value={`${origin}${path}`} className="mt-3" />
    </div>
  );
}

export function RevokeInviteButton({ slug, inviteId }: { slug: string; inviteId: number }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={async () => {
        const r = await revokeInviteAction(slug, inviteId);
        setError(r.ok ? null : r.error.message);
      }}
    >
      <PendingButton className={smallBtn}>Revoke</PendingButton>
      <FormError message={error} />
    </form>
  );
}

function PendingButton({ className, children }: { className: string; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? "…" : children}
    </button>
  );
}

export function SettingsForm({
  slug,
  defaults,
  locked,
}: {
  slug: string;
  defaults: { recruiting_open: boolean; seeking_skills: string };
  locked: boolean;
}) {
  const [state, action] = useActionState<TeamFormState, FormData>(updateSettingsAction.bind(null, slug), null);
  return (
    <form action={action} className="space-y-5">
      <Toggle
        name="recruiting_open"
        label="Recruiting"
        defaultChecked={defaults.recruiting_open && !locked}
        disabled={locked}
        description={locked ? "The roster is locked, so the team is no longer listed." : "List the team in the matchmaker with its open seats."}
      />
      <div>
        <Label htmlFor="s-seeking">Skills you&apos;re looking for</Label>
        <TagInput id="s-seeking" name="seeking_skills" defaultValue={defaults.seeking_skills} options={SKILL_SUGGESTIONS} placeholder="Start typing: fr… → frontend" />
      </div>
      <ActionNote state={state} ok="Team settings saved." />
      <SubmitButton pending="Saving…" className="min-h-11">
        Save settings
      </SubmitButton>
    </form>
  );
}

export function RosterButtons({ slug, memberId, name }: { slug: string; memberId: number; name: string }) {
  const [rm, rmAction] = useActionState<TeamFormState, FormData>(removeMemberAction.bind(null, slug, memberId), null);
  const [cap, capAction] = useActionState<TeamFormState, FormData>(transferCaptainAction.bind(null, slug, memberId), null);
  // An in-page confirm step rather than window.confirm(), so it can't be skipped silently.
  const [asking, setAsking] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={capAction}>
        <PendingButton className={smallBtn}>Make captain</PendingButton>
      </form>
      {asking ? (
        <form action={rmAction} role="alertdialog" aria-label={`Remove ${name}?`} className="flex flex-wrap items-center gap-2">
          <span className="font-plex text-xs text-warning">Remove {name} from the team?</span>
          <PendingButton className={dangerBtn}>Yes, remove</PendingButton>
          <button type="button" onClick={() => setAsking(false)} className={smallBtn}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setAsking(true)} className={dangerBtn}>
          Remove
        </button>
      )}
      <div className="basis-full">
        <ActionNote state={rm?.ok ? null : rm} />
        <ActionNote state={cap?.ok ? null : cap} />
      </div>
    </div>
  );
}

export function AdvanceStateButton({ slug, to, label }: { slug: string; to: "formed" | "active"; label: string }) {
  const [state, action] = useActionState<TeamFormState, FormData>(advanceStateAction.bind(null, slug, to), null);
  return (
    <form action={action} className="space-y-2">
      <PendingButton className={smallBtn}>{label}</PendingButton>
      <ActionNote state={state} ok="Team state updated." />
    </form>
  );
}

/**
 * "Next: activate" for the captain of an unlocked team: confirm this is the final
 * team first. Confirming locks the roster for everyone and goes to /activate.
 */
export function FinalTeamConfirm({ slug, teamName, members, cap, testmuSync }: { slug: string; teamName: string; members: string[]; cap: number; testmuSync: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<TeamFormState, FormData>(confirmFinalTeamAction.bind(null, slug), null);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center bg-bright px-5 font-plex text-sm text-ink transition-colors hover:bg-lime">
        Next: activate →
      </button>
    );
  }
  const seats = cap - members.length;
  return (
    <form action={action} role="alertdialog" aria-labelledby="final-team-title" className="w-full space-y-4 border border-warning bg-ink p-5">
      <p className="font-pixel text-[10px] uppercase tracking-[0.2em] text-warning">Before you activate</p>
      <h3 id="final-team-title" className="font-display text-2xl text-bright">
        Is this your final team?
      </h3>
      <p className="font-plex text-sm leading-relaxed text-lightgray">
        Continuing locks <span className="text-bright">{teamName}</span> with{" "}
        <span className="text-bright">
          {members.length} {members.length === 1 ? "person" : "people"}
        </span>
        : {members.join(", ")}. Nobody can join or leave after this, and open invite codes stop working. Only an organizer can change it.
      </p>
      {seats > 0 && (
        <p className="border-l-2 border-warning pl-3 font-plex text-sm text-warning">
          You still have {seats} open {seats === 1 ? "seat" : "seats"}. If a teammate hasn&apos;t joined yet, wait for them first.
        </p>
      )}
      <label className="flex min-h-11 cursor-pointer items-start gap-3 font-plex text-sm text-bright">
        <input type="checkbox" name="confirm" required className="mt-1 h-5 w-5 accent-[var(--lime)]" />
        <span>Yes, this is our final team. Lock it.</span>
      </label>
      {testmuSync && <TestmuPasswordField id="final-testmu-pw" />}
      <ActionNote state={state} />
      <div className="flex flex-wrap items-center gap-3">
        <PendingButton className="inline-flex min-h-11 items-center bg-lime px-5 font-plex text-sm text-ink hover:bg-bright disabled:opacity-60">Lock the team and continue →</PendingButton>
        <button type="button" onClick={() => setOpen(false)} className={smallBtn}>
          Not yet
        </button>
      </div>
    </form>
  );
}

/**
 * Teammates (not the captain) of a team that isn't confirmed yet: a muted
 * "Next: activate" and a note. Polls the flow every 5s and moves on to
 * /activate by itself once the captain confirms.
 */
export function WaitingForCaptain({ captainName }: { captainName: string | null }) {
  const router = useRouter();
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await apiFetch("/api/v1/me/flow", { cache: "no-store" });
        const j = (await r.json()) as { stage: string | null; next?: string };
        if (!stop && j.stage && j.stage !== "team" && j.next) router.push(j.next);
      } catch {
        // offline for a moment: try again on the next tick
      }
    };
    const id = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [router]);
  return (
    <div className="space-y-2">
      <button type="button" disabled aria-disabled="true" className="inline-flex min-h-11 cursor-not-allowed items-center border border-hairline px-5 font-plex text-sm text-lightgray/60">
        Next: activate →
      </button>
      <p className="font-plex text-sm text-lightgray">
        Waiting for {captainName ?? "your captain"} to confirm the final team. This page moves on to activation by itself once they do.
      </p>
    </div>
  );
}

export function LeaveTeamForm({ teamName }: { teamName: string }) {
  const [state, action] = useActionState<TeamFormState, FormData>(leaveTeamAction, null);
  return (
    <form action={action} className="space-y-3">
      <label className="flex min-h-11 cursor-pointer items-start gap-3 font-plex text-sm text-bright">
        <input type="checkbox" name="confirm" required className="mt-1 h-5 w-5 accent-[var(--lime)]" />
        <span>I want to leave {teamName}. My personal registration stays.</span>
      </label>
      <ActionNote state={state} />
      <PendingButton className={dangerBtn}>Leave team</PendingButton>
    </form>
  );
}

const OVERRIDES = [
  { id: "add_member", label: "Add a participant (by P-code)" },
  { id: "remove_member", label: "Remove a member" },
  { id: "set_captain", label: "Change captain" },
  { id: "reopen_roster", label: "Reopen the roster" },
  { id: "lock_roster", label: "Lock the roster now" },
  { id: "set_max_size", label: "Change team size" },
] as const;

export function OverrideForm({ slug, members }: { slug: string; members: { id: number; name: string }[] }) {
  const [state, action] = useActionState<TeamFormState, FormData>(overrideAction.bind(null, slug), null);
  const [kind, setKind] = useState<(typeof OVERRIDES)[number]["id"]>("add_member");
  return (
    <form action={action} className="space-y-4">
      <div>
        <Label htmlFor="ov-action">Change</Label>
        <select id="ov-action" name="action" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={`${inputCls} min-h-11`}>
          {OVERRIDES.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {kind === "add_member" && (
        <div>
          <Label htmlFor="ov-code">Participant P-code</Label>
          <input id="ov-code" name="member_code" required placeholder="P-1234" className={inputCls} />
        </div>
      )}
      {(kind === "remove_member" || kind === "set_captain") && (
        <div>
          <Label htmlFor="ov-member">Member</Label>
          <select id="ov-member" name="member_id" required defaultValue="" className={`${inputCls} min-h-11`}>
            <option value="" disabled>
              Pick a member
            </option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {kind === "set_max_size" && (
        <div>
          <Label htmlFor="ov-size">Team size (1–4)</Label>
          <input id="ov-size" name="max_size" type="number" min={1} max={4} required className={inputCls} />
        </div>
      )}
      <div>
        <Label htmlFor="ov-reason" hint="Required · goes in the audit log">
          Reason
        </Label>
        <textarea id="ov-reason" name="reason" required minLength={10} maxLength={500} rows={2} className={inputCls} placeholder="e.g. Walk-in admitted at 11:20, captain asked at the desk" />
      </div>
      <ActionNote state={state} ok="Override applied and audited." />
      <SubmitButton pending="Applying…" className="min-h-11">
        Apply override
      </SubmitButton>
    </form>
  );
}

/** Captain: add the teammates not in the TestMu AI team yet. Members already added or invited are skipped. */
export function TestmuSyncRetryForm({ slug }: { slug: string }) {
  const [state, action] = useActionState<SyncFormState, FormData>(retryTestmuSyncAction.bind(null, slug), null);
  return (
    <form action={action} className="space-y-3" data-testmu-sync-retry>
      <TestmuPasswordField id="sync-testmu-pw" />
      <ActionNote state={state} ok={state?.ok && state.data.stopped ? "Tried again. Some teammates still need attention, see above." : "Tried again. See the statuses above."} />
      <SubmitButton pending="Adding teammates…" className="min-h-11">
        Retry the ones that failed
      </SubmitButton>
    </form>
  );
}

function TestmuPasswordField({ id }: { id: string }) {
  return (
    <div>
      <Label htmlFor={id} hint="Used once · never stored">
        Your TestMu AI password
      </Label>
      <input id={id} name="testmu_password" type="password" required minLength={8} maxLength={255} autoComplete="current-password" className={inputCls} />
      <p className="mt-2 font-plex text-xs text-lightgray">We use it once to move your teammates into your TestMu AI team. It’s never stored.</p>
    </div>
  );
}
