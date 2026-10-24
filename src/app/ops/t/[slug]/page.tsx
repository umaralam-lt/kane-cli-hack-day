import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { event } from "@/data/hackday";
import { PROGRESS_ITEMS, shippedMinimum } from "@/lib/progress";
import { getEventPhotos, getMemberProfiles, getTeamPhotoInfo, photoSrc } from "@/lib/photos";
import { isAdmin } from "@/lib/session";
import { getActivity, getMembers, getProgress, getTeamBySlug } from "@/lib/teams";
import { teamSyncMessage, teamSyncStatus } from "@/server/testmu";
import { AdminLogin } from "../../parts";

export const metadata: Metadata = { title: "Admin · Team", robots: { index: false } };

export default function AdminTeamPage({ params }: PageProps<"/ops/t/[slug]">) {
  return (
    <main className="py-16 sm:py-20">
      <div className="container-page">
        <Suspense fallback={<p className="font-plex text-sm text-lightgray">Loading…</p>}>
          <Detail params={params} />
        </Suspense>
      </div>
    </main>
  );
}

const when = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: event.timezone });

const stamp = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: event.timezone, timeZoneName: "short" });

const label = "mb-3 font-pixel text-[10px] uppercase tracking-[0.2em] text-lightgray";

async function Detail({ params }: Pick<PageProps<"/ops/t/[slug]">, "params">) {
  if (!(await isAdmin())) return <AdminLogin />;
  const { slug } = await params;
  const team = await getTeamBySlug(slug);
  if (!team) notFound();

  const [members, progress, activity, photoInfo, profiles, gallery, testmuSync] = await Promise.all([
    getMembers(team.id),
    getProgress(team.id),
    getActivity(team.id, 200),
    getTeamPhotoInfo(team.id),
    getMemberProfiles(team.id),
    getEventPhotos(team.id),
    teamSyncStatus(team.id),
  ]);
  const profileOf = new Map(profiles.map((p) => [p.id, p]));
  const teamPhoto = photoSrc(photoInfo.photo_url);
  const byItem = new Map(progress.map((p) => [p.item, p]));
  const done = new Set(progress.filter((p) => p.done).map((p) => p.item));

  return (
    <div className="space-y-12">
      <div>
        <Link href="/ops" className="font-plex text-xs text-lightgray hover:text-lime">
          ← All teams
        </Link>
        <h1 className="mt-4 font-display text-4xl text-bright">{team.name}</h1>
        <p className="mt-2 font-plex text-sm text-lightgray">
          {team.is_solo ? "Solo" : "Team"} · {team.track} · registered {when.format(team.created_at)} ·{" "}
          <Link href={`/t/${team.slug}`} className="text-bright hover:text-lime">
            /t/{team.slug}
          </Link>
        </p>
        <p className="mt-4 max-w-2xl border-l-2 border-lime pl-4 font-plex text-bright">{team.idea}</p>
      </div>

      <div className="grid gap-12 lg:grid-cols-2">
        <div>
          <p className={label}>Members · {members.length}</p>
          <ul className="border-t border-dashed border-hairline">
            {members.map((m) => {
              const p = profileOf.get(m.id);
              const selfie = photoSrc(p?.photo_url);
              return (
                <li key={m.id} className="flex items-center gap-3 border-b border-dashed border-hairline py-3 font-plex text-sm">
                  {selfie ? (
                    <a href={selfie} target="_blank" rel="noreferrer" className="shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element -- private blob proxy, not optimizable */}
                      <img src={selfie} alt={`${m.name} selfie`} loading="lazy" className="size-12 border border-hairline object-cover" />
                    </a>
                  ) : (
                    <span className="flex size-12 shrink-0 items-center justify-center border border-dashed border-hairline text-[10px] text-lightgray">
                      no selfie
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 flex-wrap justify-between gap-x-3 gap-y-1">
                    <span className="text-bright">{m.name}</span>
                    <a href={`mailto:${m.email}`} className="break-all text-lightgray hover:text-lime">
                      {m.email}
                    </a>
                    <span className="flex w-full gap-3 text-xs">
                      {p?.linkedin ? (
                        <a href={p.linkedin} target="_blank" rel="noreferrer" className="text-lightgray hover:text-lime">
                          LinkedIn ↗
                        </a>
                      ) : (
                        <span className="text-lightgray/50">no LinkedIn</span>
                      )}
                      {p?.x_handle ? (
                        <a href={`https://x.com/${p.x_handle}`} target="_blank" rel="noreferrer" className="text-lightgray hover:text-lime">
                          @{p.x_handle} ↗
                        </a>
                      ) : (
                        <span className="text-lightgray/50">no X</span>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          <p className={label}>
            Progress · {done.size}/{PROGRESS_ITEMS.length}
            {shippedMinimum(done) && <span className="ml-2 text-bright">· shipped</span>}
          </p>
          <ul className="border-t border-dashed border-hairline">
            {PROGRESS_ITEMS.map((item) => {
              const row = byItem.get(item.id);
              return (
                <li key={item.id} className="border-b border-dashed border-hairline py-3 font-plex text-sm">
                  <div className="flex justify-between gap-3">
                    <span className={row?.done ? "text-bright" : "text-lightgray"}>
                      {row?.done ? "■" : "□"} {item.label}
                    </span>
                    {row?.updated_by_name && (
                      <span className="text-xs text-lightgray">
                        {row.updated_by_name} · {when.format(row.updated_at)}
                      </span>
                    )}
                  </div>
                  {row?.value &&
                    (/^https?:\/\//.test(row.value) ? (
                      <a href={row.value} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-lightgray hover:text-lime">
                        {row.value}
                      </a>
                    ) : (
                      <p className="mt-1 break-all text-xs text-lightgray">{row.value}</p>
                    ))}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="grid gap-12 lg:grid-cols-2">
        <div>
          <p className={label}>Team photo</p>
          {teamPhoto ? (
            <a href={teamPhoto} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element -- private blob proxy, not optimizable */}
              <img src={teamPhoto} alt={`${team.name} team photo`} className="max-h-96 w-full border border-hairline object-contain" />
            </a>
          ) : (
            <p className="border border-dashed border-hairline p-6 font-plex text-sm text-lightgray">No team photo yet.</p>
          )}
        </div>
        <div>
          <p className={label}>Consent · each person answers for themselves</p>
          <ul className="border-t border-dashed border-hairline font-plex text-sm">
            {profiles.map((p) => (
              <li key={p.id} className="flex items-baseline justify-between gap-4 border-b border-dashed border-hairline py-2">
                <span className="text-bright">{p.name}</span>
                <span className="text-xs">
                  {p.consent_social === true ? (
                    <span className="text-lime">■ Yes</span>
                  ) : p.consent_social === false ? (
                    <span className="text-red-300">□ No: don&apos;t post or tag</span>
                  ) : (
                    <span className="text-lightgray">… Not asked yet</span>
                  )}
                  {p.consent_at && <span className="ml-2 text-lightgray">{stamp.format(p.consent_at)}</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 font-plex text-xs text-lightgray">The team photo is only used for matching once everyone has said yes.</p>
        </div>
      </div>

      <div>
        <p className={label}>Event gallery · {gallery.length}</p>
        {gallery.length ? (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {gallery.map((ph) => {
              const src = photoSrc(ph.pathname)!;
              return (
                <li key={ph.id}>
                  <a href={src} target="_blank" rel="noreferrer" className="block">
                    {/* eslint-disable-next-line @next/next/no-img-element -- private blob proxy, not optimizable */}
                    <img
                      src={src}
                      alt={ph.caption ?? `${team.name} event photo`}
                      width={ph.width ?? undefined}
                      height={ph.height ?? undefined}
                      loading="lazy"
                      className="aspect-[4/3] w-full border border-hairline object-cover"
                    />
                  </a>
                  <p className="mt-1 font-plex text-[11px] text-lightgray">
                    {ph.caption ? `${ph.caption} · ` : ""}
                    {when.format(ph.created_at)}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="font-plex text-sm text-lightgray">No event photos matched to this team yet.</p>
        )}
      </div>

      <div>
        <p className={label}>Activity</p>
        <ol className="border-t border-dashed border-hairline">
          {activity.map((a) => (
            <li key={a.id} className="flex justify-between gap-4 border-b border-dashed border-hairline py-2.5 font-plex text-xs">
              <span>
                <span className="text-bright">{a.member_name ?? "Team"}</span> <span className="text-lightgray">· {a.action}</span>
              </span>
              <span className="text-lightgray">{when.format(a.created_at)}</span>
            </li>
          ))}
        </ol>
      </div>

      {testmuSync.length > 0 && (
        <div>
          <p className={label}>TestMu AI team sync · {testmuSync.filter((s) => s.done).length}/{testmuSync.length} in the captain’s team</p>
          <ul className="border-t border-dashed border-hairline">
            {testmuSync.map((s) => (
              <li key={s.member_id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b border-dashed border-hairline py-2.5 font-plex text-xs">
                <span>
                  <span className="text-bright">{s.name}</span> <span className={s.done ? "text-lime" : "text-warning"}>· {s.code ?? "not synced"}</span>
                  <span className="block text-lightgray">{teamSyncMessage(s.code, s.name)}</span>
                </span>
                {s.attempted_at && <span className="text-lightgray">{when.format(s.attempted_at)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
