import type { Metadata } from "next";
import { requireOwner, userCtx } from "@/lib/auth/session";
import { listBrands } from "@/lib/services/brands";
import { listTeam } from "@/lib/services/users";
import { InviteForm, MemberRow, PendingInvite } from "./team-ui";

export const metadata: Metadata = { title: "Team · Social Planner" };

export default async function TeamPage() {
  const me = await requireOwner();
  const ctx = await userCtx();
  const [team, brands] = await Promise.all([listTeam(ctx), listBrands(ctx)]);
  const brandOpts = brands.map((b) => ({ id: b.id, name: b.name }));

  return (
    <div className="grid gap-8">
      <section>
        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="mt-1 text-muted-foreground">Invite people, set their role and choose which brands they can see.</p>
      </section>

      <section aria-labelledby="invite-h" className="glass rounded-[22px] p-5 sm:p-6">
        <h2 id="invite-h" className="mb-4 font-medium">Invite someone</h2>
        <InviteForm brands={brandOpts} />
      </section>

      {team.invites.length > 0 && (
        <section aria-labelledby="pending-h">
          <h2 id="pending-h" className="mb-3 font-medium">Pending invites</h2>
          <ul className="grid gap-2">
            {team.invites.map((i) => (
              <PendingInvite key={i.id} invite={i} brandNames={i.brandIds.map((id) => brandOpts.find((b) => b.id === id)?.name ?? "?")} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="people-h">
        <h2 id="people-h" className="mb-3 font-medium">People ({team.users.length})</h2>
        <ul className="grid gap-2">
          {team.users.map((u) => (
            <MemberRow key={u.id} member={u} brands={brandOpts} isSelf={u.id === me.userId} />
          ))}
        </ul>
      </section>
    </div>
  );
}
