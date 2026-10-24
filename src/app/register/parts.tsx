"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FormError, Label, SubmitButton, inputCls } from "@/components/forms/fields";
import HumanCameraCheckpoint from "@/components/camera/HumanCameraCheckpoint";
import { checkProfileFields } from "@/lib/profile-fields";
import { choiceAction, profileAction, retryTestmuAction, skipPhotoAction, type ChoiceState, type ProfileState, type TestmuRetryState } from "./actions";
import { apiFetch } from "@/lib/api-client";

// The three /register steps. The server decides which one shows.

export type ProfileDefaults = {
  name: string;
  email: string;
  github: string;
  x: string;
  linkedin: string;
  looking: boolean;
};

// Larger type than the shared form fields: this is the first form people fill in.
const field = `${inputCls.replace("text-sm", "text-base").replace("py-2.5", "py-3")} aria-[invalid=true]:border-danger`;

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-pixel text-xs uppercase tracking-[0.2em] text-bright">{label}</span>
        {hint && <span className="font-plex text-sm text-lightgray">{hint}</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-2 font-plex text-sm text-danger">
          <span aria-hidden="true">✕ </span>
          {error}
        </p>
      )}
    </div>
  );
}

export function ProfileStep({ defaults, signedIn, hasPassword }: { defaults: ProfileDefaults; signedIn: boolean; hasPassword: boolean }) {
  const [state, action] = useActionState<ProfileState, FormData>(profileAction, null);
  const v = { ...defaults, ...(state?.values ?? {}) };
  const looking = state?.values ? state.values.looking === "yes" : defaults.looking;
  // Checked in the browser on submit (same rules as the server); a field's message clears as soon as it's edited.
  const [checked, setChecked] = useState<Record<string, string> | null>(null);
  const fe: Record<string, string> = checked ?? state?.fieldErrors ?? {};
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? "");
    const problems = checkProfileFields(
      {
        name: get("name"),
        email: get("email"),
        linkedin: get("linkedin"),
        x: get("x"),
        github: get("github"),
        password: get("password"),
      },
      { passwordRequired: !hasPassword && !state?.needsProof },
    );
    const first = Object.keys(problems)[0];
    // Passing the browser check hands over to the server's answer (state.fieldErrors).
    setChecked(first ? problems : null);
    if (first) {
      e.preventDefault();
      const el = e.currentTarget.querySelector<HTMLElement>(`[name="${first}"]:not([type=hidden])`) ?? document.getElementById(`r-${first}`);
      el?.focus();
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };
  const onInput = (e: FormEvent<HTMLFormElement>) => {
    const name = (e.target as HTMLInputElement).name;
    if (name && fe[name]) setChecked(Object.fromEntries(Object.entries(fe).filter(([k]) => k !== name)));
  };
  const count = Object.keys(fe).length;
  const err = (k: string) => (fe[k] ? { "aria-invalid": true, "aria-describedby": `r-${k}-error` } : {});
  // Remount after each answer so the fields show what was typed (React resets forms after an action).
  const formKey = JSON.stringify(state?.values ?? defaults) + (state?.needsProof ? ":proof" : "");
  return (
    <form key={formKey} action={action} onSubmit={onSubmit} onInput={onInput} noValidate className="space-y-7" data-step="profile">
      <Field id="r-name" label="Your name" error={fe.name}>
        <input id="r-name" name="name" required minLength={2} maxLength={60} autoComplete="name" defaultValue={v.name} className={field} {...err("name")} />
      </Field>
      <Field id="r-email" label="Email" hint="The one you used on Luma" error={fe.email}>
        <input id="r-email" name="email" type="email" required autoComplete="email" defaultValue={v.email} className={field} {...err("email")} />
      </Field>
      <div className="grid gap-6 sm:grid-cols-2">
        <Field id="r-linkedin" label="LinkedIn" hint="Link or name" error={fe.linkedin}>
          <SocialInput kind="linkedin" id="r-linkedin" name="linkedin" required defaultValue={v.linkedin} placeholder="your-name or linkedin.com/in/your-name" className={field} invalid={err("linkedin")} />
        </Field>
        <Field id="r-x" label="X (Twitter)" hint="Link or @handle" error={fe.x}>
          <SocialInput kind="x" id="r-x" name="x" required defaultValue={v.x} placeholder="@handle or x.com/handle" className={field} invalid={err("x")} />
        </Field>
      </div>
      <Field id="r-gh" label="GitHub" hint="Optional · link or username" error={fe.github}>
        <SocialInput kind="github" id="r-gh" name="github" defaultValue={v.github} placeholder="username or github.com/username" className={field} invalid={err("github")} />
      </Field>
      <Field id="r-pw" label={hasPassword ? "New password" : "Choose a password"} hint={hasPassword ? "Optional · leave blank to keep yours" : "8+ characters"} error={fe.password}>
        <input id="r-pw" name="password" type="password" minLength={8} required={!hasPassword && !state?.needsProof} autoComplete="new-password" className={field} {...err("password")} />
        <p className="mt-2 font-plex text-sm text-lightgray">So you can sign back in on another device with your email and this password.</p>
      </Field>

      <label className="flex min-h-11 cursor-pointer items-start gap-4 border-2 border-hairline p-5 transition-colors has-[:checked]:border-lime has-[:checked]:bg-lime-deep">
        <input type="checkbox" name="looking" value="yes" defaultChecked={looking} className="mt-1 h-6 w-6 shrink-0 accent-[var(--lime)]" />
        <span>
          <span className="block font-display text-xl text-bright">Are you looking to form a team? Join matchmaking</span>
          <span className="mt-1 block font-plex text-sm leading-relaxed text-lightgray">
            Tick this and you go into the matchmaking round. Next you add your skills so people and teams with open seats can find you (they never see your email), and an organizer can put a team
            together for you. Leave it unticked if you already have a team or will create one.
          </span>
        </span>
      </label>

      {state?.needsProof && !signedIn && <ProofFields />}

      {count > 0 ? (
        <p role="alert" className="border-l-2 border-danger pl-4 font-plex text-base text-danger">
          {count === 1 ? "One thing to fix above: " + Object.values(fe)[0] : `${count} things to fix above. Each one is marked in red.`}
          {checked === null && !signedIn && !hasPassword ? " Then type your password again." : ""}
        </p>
      ) : (
        <FormError message={checked === null ? state?.error : undefined} />
      )}
      <SubmitButton pending="Saving…" className="min-h-12 text-base">
        {signedIn ? "Save and continue →" : state?.needsProof ? "Confirm it’s me →" : "Create my profile →"}
      </SubmitButton>
    </form>
  );
}

type CheckStatus = "idle" | "checking" | "verified" | "not_found" | "unknown" | "invalid";

const INVALID: Record<"linkedin" | "x" | "github", string> = {
  linkedin: "That link has no profile name. It should look like linkedin.com/in/your-name.",
  x: "That isn’t an X handle. Use @handle or x.com/handle.",
  github: "That isn’t a GitHub username. Use your-name or github.com/your-name.",
};

const NOT_FOUND: Record<"linkedin" | "x" | "github", string> = {
  linkedin: "We couldn’t find this LinkedIn profile. Check the spelling, or paste the link from your profile page.",
  x: "There’s no X account with this handle. Check the spelling.",
  github: "There’s no GitHub user with this name. Check the spelling.",
};

/**
 * A LinkedIn / X / GitHub field that checks the profile is real when you leave
 * it: ✓ verified, ✕ not found. LinkedIn often refuses automated checks, so
 * "couldn't check" is shown quietly and never blocks anyone.
 */
function SocialInput({ kind, invalid, className, ...input }: { kind: "linkedin" | "x" | "github"; invalid: object; className: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const [status, setStatus] = useState<CheckStatus>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const last = useRef("");
  const check = async (value: string) => {
    const v = value.trim();
    if (!v || v === last.current) return;
    last.current = v;
    setStatus("checking");
    const r = await apiFetch("/api/v1/profile/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, value: v }) }).catch(() => null);
    if (last.current !== v) return;
    const out = r ? ((await r.json().catch(() => null)) as { status: CheckStatus; url: string | null } | null) : null;
    setStatus(out?.status ?? "unknown");
    setUrl(out?.url ?? null);
  };
  const tone = status === "verified" ? "border-lime" : status === "not_found" || status === "invalid" ? "border-danger" : "";
  return (
    <>
      <div className="relative">
        <input
          {...input}
          {...invalid}
          autoComplete="off"
          onBlur={(e) => void check(e.target.value)}
          onChange={() => {
            last.current = "";
            setStatus("idle");
          }}
          className={`${className} pr-11 ${tone}`}
        />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-plex text-lg" aria-hidden="true">
          {status === "verified" ? <span className="text-lime">✓</span> : status === "not_found" || status === "invalid" ? <span className="text-danger">✕</span> : status === "checking" ? <span className="text-lightgray">…</span> : null}
        </span>
      </div>
      <p className="mt-2 min-h-5 font-plex text-sm" aria-live="polite">
        {status === "checking" && <span className="text-lightgray">Checking…</span>}
        {status === "verified" && (
          <span className="text-lime">
            ✓ Verified{" "}
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className="text-lightgray underline underline-offset-4 hover:text-lime">
                {url.replace(/^https:\/\/(www\.)?/, "")}
              </a>
            )}
          </span>
        )}
        {status === "not_found" && <span className="text-danger">✕ {NOT_FOUND[kind]}</span>}
        {status === "invalid" && <span className="text-danger">✕ {INVALID[kind]}</span>}
        {status === "unknown" && kind === "linkedin" && <span className="text-lightgray">LinkedIn didn’t let us check this one automatically. Open the link once to make sure it’s your profile.</span>}
      </p>
    </>
  );
}

/** An email that already has an account: prove it's yours, never take it over silently. */
function ProofFields() {
  const [mode, setMode] = useState<"password" | "code">("password");
  return (
    <div className="space-y-4 border border-warning bg-warning-deep p-4" role="group" aria-labelledby="proof-title">
      <p id="proof-title" className="font-plex text-sm text-warning">
        <span aria-hidden="true">◷ </span>
        That email already has an account. Confirm it’s yours to continue.
      </p>
      {mode === "password" ? (
        <div>
          <Label htmlFor="r-proof-pw">Its password</Label>
          <input id="r-proof-pw" name="proof_password" type="password" autoComplete="current-password" required className={inputCls} />
        </div>
      ) : (
        <div>
          <Label htmlFor="r-proof-code" hint="From the check-in desk">
            One-time code
          </Label>
          <input id="r-proof-code" name="proof_code" autoComplete="one-time-code" placeholder="XXXX-XXXX" required className={`${inputCls} uppercase tracking-[0.2em]`} />
        </div>
      )}
      <button type="button" onClick={() => setMode(mode === "password" ? "code" : "password")} className="min-h-11 font-plex text-xs text-bright underline underline-offset-4 hover:text-lime">
        {mode === "password" ? "No password? Use a one-time code from the desk" : "Use the password instead"}
      </button>
    </div>
  );
}

export function PhotoStep({ hasPhoto, avatar }: { hasPhoto: boolean; avatar: string | null }) {
  const router = useRouter();
  const [consent, setConsent] = useState(false);
  return (
    <div className="space-y-6" data-step="photo">
      {hasPhoto && avatar && (
        <div className="flex items-center gap-4 border border-hairline p-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- private, cookie-gated image */}
          <img src={avatar} alt="Your current photo" width={64} height={64} className="h-16 w-16 rounded-full object-cover" />
          <p className="font-plex text-sm text-lightgray">This is your current photo. Take a new one below, or keep it.</p>
        </div>
      )}
      <label className="flex min-h-11 cursor-pointer items-start gap-3 font-plex text-sm text-bright">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 h-5 w-5 accent-[var(--lime)]" />
        <span>
          Store my photo as my profile picture
          <span className="mt-1 block text-xs text-lightgray">
            Kept privately for the event and shown to you, your teammates, staff, and (if you join matchmaking) other people looking for a team. Deleted after the event, or when you switch it off on your profile.
          </span>
        </span>
      </label>
      {consent ? (
        <HumanCameraCheckpoint uploadUrl="/api/v1/profile/photo" fields={{ consent: "1" }} onDone={() => router.refresh()} />
      ) : (
        <p className="border border-dashed border-hairline p-4 text-center font-plex text-sm text-lightgray">Tick the box to open the camera. You press the shutter yourself; nothing is recorded before that.</p>
      )}
      <form action={skipPhotoAction} className="flex flex-wrap items-center gap-4 border-t border-dashed border-hairline pt-4">
        <button type="submit" className="inline-flex min-h-11 items-center justify-center border border-hairline px-4 py-2.5 font-plex text-sm text-bright transition-colors hover:border-lime hover:text-lime">
          {hasPhoto ? "Keep this photo →" : "Skip the photo →"}
        </button>
        <p className="font-plex text-xs text-lightgray">Your initials show instead. You can add a photo later from your profile.</p>
      </form>
    </div>
  );
}

export function ChoiceStep() {
  const [state, action] = useActionState<ChoiceState, FormData>(choiceAction, null);
  return (
    <form action={action} className="space-y-6" data-step="choice">
      <fieldset className="space-y-3">
        <legend className="mb-4 font-display text-2xl text-bright">Are you looking to form a team?</legend>
        <Choice value="yes" title="Yes, match me" body="You join the matchmaking pool. People and teams with open seats see your name, photo, skills and interests (never your email). An organizer can also put a team together for you." />
        <Choice value="no" title="No, I have a team (or I’m going solo)" body="Create your team, or join one with an invite code from a teammate. Teams are up to 4 people." />
      </fieldset>
      <FormError message={state?.error} />
      <SubmitButton pending="Saving…" className="min-h-11">
        Continue →
      </SubmitButton>
      <p className="font-plex text-xs text-lightgray">
        Changed your mind later? Switch any time from <Link href="/team" className="underline underline-offset-4 hover:text-lime">your team page</Link>.
      </p>
    </form>
  );
}

function Choice({ value, title, body }: { value: string; title: string; body: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 border border-hairline p-4 transition-colors has-[:checked]:border-lime has-[:checked]:bg-lime-deep">
      <input type="radio" name="looking" value={value} required className="mt-1 h-5 w-5 accent-[var(--lime)]" />
      <span>
        <span className="block font-plex text-sm text-bright">{title}</span>
        <span className="mt-1 block font-plex text-xs leading-relaxed text-lightgray">{body}</span>
      </span>
    </label>
  );
}

/** Retry TestMu AI activation with the TestMu AI password. Sent once to TestMu AI, never stored. */
export function TestmuRetryForm({ email, wrongPassword }: { email: string; wrongPassword: boolean }) {
  const [state, action] = useActionState<TestmuRetryState, FormData>(retryTestmuAction, null);
  const wrong = state?.wrongPassword ?? wrongPassword;
  return (
    <form action={action} className="mt-4 max-w-md space-y-3" data-testmu-retry={wrong ? "wrong_password" : "retry"}>
      <div>
        <Label htmlFor="r-testmu-pw" hint="Never stored">
          {wrong ? `TestMu AI password for ${email}` : "Your TestMu AI password"}
        </Label>
        <input id="r-testmu-pw" name="testmu_password" type="password" required minLength={8} maxLength={255} autoComplete="current-password" className={inputCls} />
      </div>
      <FormError message={state?.error} />
      <SubmitButton pending="Activating…" className="min-h-11">
        Activate TestMu AI →
      </SubmitButton>
    </form>
  );
}
