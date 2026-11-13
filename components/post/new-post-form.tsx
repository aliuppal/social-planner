"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/auth/field";
import { createPostAction } from "@/app/(app)/actions";
import { TYPE_LABEL } from "@/lib/ui/meta";
import { fieldCls } from "./field-styles";

export function NewPostForm({
  brands,
  calendars,
  initial,
}: {
  brands: { id: string; name: string; timezone: string }[];
  calendars: { id: string; name: string; brandId: string }[];
  initial: { brandId?: string; at?: string; calendarId?: string };
}) {
  const router = useRouter();
  const [brandId, setBrandId] = useState(brands.find((b) => b.id === initial.brandId)?.id ?? brands[0].id);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const brand = brands.find((b) => b.id === brandId)!;
  const brandCals = calendars.filter((c) => c.brandId === brandId);

  async function submit(form: FormData) {
    setPending(true);
    setError(null);
    const r = await createPostAction({
      brandId,
      type: String(form.get("type")) as "image",
      caption: String(form.get("caption") ?? ""),
      local: String(form.get("at") ?? "") || undefined,
      calendarIds: form.getAll("calendarIds").map(String),
    });
    setPending(false);
    if (!r.ok) return setError(r.error);
    router.push(`/posts/${r.data.id}`);
  }

  return (
    <form action={submit} className="glass grid gap-4 rounded-[22px] p-5 sm:p-6">
      {error && <FormMessage>{error}</FormMessage>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="brand">Brand</Label>
          <select id="brand" value={brandId} onChange={(e) => setBrandId(e.target.value)} className={`${fieldCls} h-11`}>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="type">Type</Label>
          <select id="type" name="type" defaultValue="image" className={`${fieldCls} h-11`}>
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="caption">Caption (you can finish it in the editor)</Label>
        <textarea id="caption" name="caption" rows={4} maxLength={2200} className={`${fieldCls} py-2.5`} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="at">Planned time ({brand.timezone})</Label>
        <input id="at" name="at" type="datetime-local" defaultValue={initial.at} className={`${fieldCls} h-11`} />
        <p className="text-sm text-muted-foreground">Optional. The post is only scheduled once it&apos;s approved and you press Schedule.</p>
      </div>
      {brandCals.length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Also add to calendars</legend>
          <div className="flex flex-wrap gap-2">
            {brandCals.map((c) => (
              <label key={c.id} className="flex min-h-11 items-center gap-2 rounded-full border border-input bg-inset px-4 text-sm has-checked:border-primary has-checked:bg-violet-soft">
                <input type="checkbox" name="calendarIds" value={c.id} defaultChecked={c.id === initial.calendarId} className="size-4 accent-[var(--acc)]" />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Creating…" : "Create draft"}
        </Button>
      </div>
    </form>
  );
}
