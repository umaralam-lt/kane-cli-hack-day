import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import FlowProgress from "@/components/FlowProgress";
import GreetingHeader from "@/components/ui/GreetingHeader";
import { query } from "@/lib/db";
import { isRegistrationOpen } from "@/lib/teams";
import { getPersonalMember } from "@/server/auth";
import { avatarSrc, avatarVersion } from "@/server/avatar";
import { flowState, type FlowStage } from "@/server/flow";
import { keyRequired } from "@/lib/testmu-gate";
import { activationEnabled } from "@/lib/testmu-provision";
import { getTestmuIdentity, takeRevealedKey } from "@/server/testmu";
import { ChoiceStep, PhotoStep, ProfileStep, type ProfileDefaults } from "./parts";
import TestmuPanel from "./testmu";

export const metadata: Metadata = { title: "Start here" };

// The event-day profile builder. Checked in at the desk? Sit down and start
// here: (a) profile, ending with the "looking for a team?" tick, then (b) photo.
// (c) asks the team question only for someone who never answered it. The step shown is
// read from the database, so a reload or a second device resumes it.
// ?edit=profile / ?edit=photo reopen a finished step.

export default function RegisterPage({ searchParams }: PageProps<"/register">) {
  return (
    <main>
      <Suspense fallback={<FlowProgress stage={null} />}>
        <Progress />
      </Suspense>
      <GreetingHeader greet={(n) => ({ dim: `Nice to meet you, ${n}.`, bright: "Let’s finish your profile." })} eyebrow="Start here" dim="Checked in?" bright="Build your profile." intro="Two minutes: who you are, where to find you, a photo, and whether you want help finding a team." />
      <section className="py-12 sm:py-16">
        <div className="container-page max-w-2xl">
          <Suspense fallback={<p className="font-plex text-sm text-lightgray">Loading…</p>}>
            <Steps searchParams={searchParams} />
          </Suspense>
        </div>
      </section>
    </main>
  );
}

async function Progress() {
  const m = await getPersonalMember();
  return <FlowProgress stage={m ? (await flowState(m.id)).stage : null} viewing="profile" />;
}

const STEP_TITLE: Partial<Record<FlowStage, [string, string]>> = {
  profile: ["Step 1 of 2", "Your profile"],
  photo: ["Step 2 of 2", "Your photo"],
  choice: ["One more thing", "Matchmaking"],
};

async function Steps({ searchParams }: Pick<PageProps<"/register">, "searchParams">) {
  const sp = await searchParams;
  const edit = typeof sp.edit === "string" ? sp.edit : "";
  const member = await getPersonalMember();

  if (!member) {
    if (!(await isRegistrationOpen())) {
      return <p className="border-l-2 border-lime pl-4 font-plex text-bright">Registration is closed. Find an organizer at the help desk.</p>;
    }
    return (
      <>
        <StepTitle stage="profile" />
        <ProfileStep defaults={{ name: "", email: "", github: "", x: "", linkedin: "", looking: false }} signedIn={false} hasPassword={false} />
        <p className="mt-8 font-plex text-sm text-lightgray">
          Already have a profile?{" "}
          <Link href="/passport/login?next=/me" className="text-bright underline underline-offset-4 hover:text-lime">
            Sign in
          </Link>
        </p>
      </>
    );
  }

  const state = await flowState(member.id);
  const stage: FlowStage = edit === "profile" ? "profile" : edit === "photo" ? "photo" : state.stage;
  const testmu = <TestmuPanel failed={sp.testmu === "failed"} memberId={member.id} email={member.email} />;
  if (stage !== "profile" && stage !== "photo" && stage !== "choice") {
    // Hold here while the TestMu AI key is on screen or activation needs a retry.
    if (!(await needsTestmuStep(sp.testmu === "failed"))) redirect(state.next);
    return testmu;
  }

  if (stage === "profile") {
    const [m] = await query<{ skills: string[] | null; interests: string[] | null; github_handle: string | null; x_handle: string | null; linkedin: string | null; looking_for_team: boolean | null; has_password: boolean }>(
      "select skills, interests, github_handle, x_handle, linkedin, looking_for_team, password_hash is not null as has_password from members where id = $1",
      [member.id],
    );
    const defaults: ProfileDefaults = {
      name: member.display_name ?? member.name,
      email: member.email,
      github: m.github_handle ?? "",
      x: m.x_handle ?? "",
      linkedin: m.linkedin ?? "",
      looking: !!m.looking_for_team,
    };
    return (
      <>
        {testmu}
        <StepTitle stage="profile" />
        <ProfileStep defaults={defaults} signedIn hasPassword={m.has_password} />
      </>
    );
  }
  if (stage === "photo") {
    const v = await avatarVersion(member.id);
    return (
      <>
        {testmu}
        <StepTitle stage="photo" />
        <PhotoStep hasPhoto={!!v} avatar={v ? avatarSrc(member.id, v) : null} />
      </>
    );
  }
  return (
    <>
      {testmu}
      <StepTitle stage="choice" />
      <ChoiceStep />
    </>
  );
}

/** Hold on /register while the key is on screen, or while the key is mandatory and missing. */
async function needsTestmuStep(failed: boolean) {
  if (!activationEnabled()) return false;
  const [key, identity] = await Promise.all([takeRevealedKey(), getTestmuIdentity()]);
  return !!key || (keyRequired() && (failed || !identity));
}

function StepTitle({ stage }: { stage: FlowStage }) {
  const [n, title] = STEP_TITLE[stage] ?? ["", ""];
  return (
    <div className="mb-8">
      <p className="font-pixel text-[10px] uppercase tracking-[0.2em] text-lightgray">{n}</p>
      <h2 className="mt-2 font-display text-3xl text-bright">{title}</h2>
    </div>
  );
}
