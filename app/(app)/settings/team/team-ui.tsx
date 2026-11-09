"use client";

import { Copy } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FormMessage } from "@/components/auth/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteAction, revokeInviteAction, updateMemberAction, type ActionResult } from "./actions";

type BrandOpt = { id: string; name: string };
type Role = "owner" | "manager" | "client";

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, all brands, users and API keys.",
  manager: "Create, edit, schedule and approve posts on chosen brands.",
  client: "See chosen brands, approve or reject, comment.",
};

const selectCls = "h-11 w-full rounded-[14px] border border-input bg-inset px-3.5 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function RolePicker({ id, value, onChange, disabled }: { id: string; value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Role</Label>
      <select id={id} name="role" value={value} onChange={(e) => onChange(e.target.value as Role)} disabled={disabled} className={selectCls}>
        <option value="client">Client</option>
        <option value="manager">Manager</option>
        <option value="owner">Owner</option>
      </select>
      <p className="text-sm text-muted-foreground">{ROLE_HELP[value]}</p>
    </div>
  );
}

function BrandPicker({ brands, selected, disabled }: { brands: BrandOpt[]; selected: string[]; disabled?: boolean }) {
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">Brands {disabled && <span className="font-normal text-muted-foreground">(owners see all)</span>}</legend>
      <div className="flex flex-wrap gap-2">
        {brands.map((b) => (
          <label key={b.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-input bg-inset px-4 text-sm has-checked:border-primary has-checked:bg-violet-soft">
            <input type="checkbox" name="brandIds" value={b.id} defaultChecked={selected.includes(b.id)} className="size-4 accent-[var(--acc)]" />
            {b.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function InviteForm({ brands }: { brands: BrandOpt[] }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(inviteAction, {});
  const [role, setRole] = useState<Role>("client");
  return (
    <form action={action} className="grid gap-4">
      {state.error && <FormMessage>{state.error}</FormMessage>}
      {state.ok && state.url && (
        <div className="grid gap-2">
          <FormMessage tone="success">{state.emailed ? "Invite emailed. You can also share this link:" : "Invite created. Email isn't set up yet, so send this link yourself:"}</FormMessage>
          <div className="flex gap-2">
            <Input readOnly value={state.url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" aria-label="Copy invite link" onClick={() => navigator.clipboard.writeText(state.url!).then(() => toast.success("Link copied"))}>
              <Copy aria-hidden />
            </Button>
          </div>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="invite-email" name="email" label="Email" type="email" autoComplete="off" required />
        <RolePicker id="invite-role" value={role} onChange={setRole} />
      </div>
      <BrandPicker brands={brands} selected={[]} disabled={role === "owner"} />
      <div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Sending…" : "Send invite"}
        </Button>
      </div>
    </form>
  );
}

export function PendingInvite({ invite, brandNames }: { invite: { id: string; email: string; role: Role; expiresAt: string }; brandNames: string[] }) {
  const [pending, start] = useTransition();
  return (
    <li className="glass flex flex-wrap items-center justify-between gap-3 rounded-[20px] px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium">{invite.email}</p>
        <p className="text-sm text-muted-foreground">
          {invite.role}
          {brandNames.length ? ` · ${brandNames.join(", ")}` : ""} · expires {new Date(invite.expiresAt).toLocaleDateString()}
        </p>
      </div>
      <Button
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await revokeInviteAction(invite.id);
            if (r.error) toast.error(r.error);
            else toast.success("Invite revoked");
          })
        }
      >
        Revoke
      </Button>
    </li>
  );
}

type Member = { id: string; name: string; email: string; role: Role; disabled: boolean; externalUserId: string | null; brandIds: string[] | "all" };

export function MemberRow({ member, brands, isSelf }: { member: Member; brands: BrandOpt[]; isSelf: boolean }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const r = await updateMemberAction(prev, form);
    if (r.ok) toast.success(`Saved ${member.name}`);
    return r;
  }, {});
  const [role, setRole] = useState<Role>(member.role);
  const names = member.brandIds === "all" ? "All brands" : member.brandIds.map((id) => brands.find((b) => b.id === id)?.name ?? "?").join(", ") || "No brands";

  return (
    <li className="glass rounded-[20px]">
      <details>
        <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3">
          <span className="min-w-0">
            <span className="block truncate font-medium">
              {member.name} {isSelf && <span className="text-muted-foreground">(you)</span>}
            </span>
            <span className="block truncate text-sm text-muted-foreground">
              {member.email} · {names}
            </span>
          </span>
          <span className="flex gap-2">
            <Badge variant="secondary">{member.role}</Badge>
            {member.disabled && <Badge variant="destructive">disabled</Badge>}
          </span>
        </summary>
        <form action={action} className="grid gap-4 border-t border-border px-4 py-4">
          {state.error && <FormMessage>{state.error}</FormMessage>}
          <input type="hidden" name="userId" value={member.id} />
          {isSelf && <input type="hidden" name="role" value={member.role} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <RolePicker id={`role-${member.id}`} value={role} onChange={setRole} disabled={isSelf} />
            <Field id={`ext-${member.id}`} name="externalUserId" label="inqi user id (optional)" defaultValue={member.externalUserId ?? ""} hint="Links approvals made in inqi to this person." />
          </div>
          <BrandPicker brands={brands} selected={member.brandIds === "all" ? [] : member.brandIds} disabled={role === "owner"} />
          {!isSelf && (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" name="disabled" defaultChecked={member.disabled} className="size-4 accent-[var(--acc)]" />
              Disable this account (signs them out everywhere)
            </label>
          )}
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </details>
    </li>
  );
}
