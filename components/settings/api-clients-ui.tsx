"use client";

import { Copy, KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/auth/field";
import { fieldCls } from "@/components/post/field-styles";
import { createApiClientAction, revokeApiClientAction, rotateApiKeyAction, type ActionResult } from "@/app/(app)/actions";
import type { Scope } from "@/lib/auth/guard";

const SCOPE_INFO: { scope: Scope; label: string }[] = [
  { scope: "posts:read", label: "Read posts & calendars" },
  { scope: "posts:write", label: "Create, edit & schedule posts" },
  { scope: "posts:approve", label: "Approve / reject" },
  { scope: "posts:publish", label: "Publish now & retry" },
  { scope: "brands:read", label: "Read brands" },
  { scope: "brands:write", label: "Edit brand guidelines" },
  { scope: "insights:read", label: "Read insights" },
];

type Client = { id: string; name: string; source: string; keyPrefix: string; scopes: string[]; brandIds: string[] | "all"; revoked: boolean; lastUsedAt: string | null };

export function ApiClientsUI({ clients, brands }: { clients: Client[]; brands: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ name: string; key: string } | null>(null);
  const [allBrands, setAllBrands] = useState(false);
  const brandName = (id: string) => brands.find((b) => b.id === id)?.name ?? "?";

  function act<T>(fn: () => Promise<ActionResult<T>>, onOk: (d: T) => void) {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onOk(r.data);
      router.refresh();
    });
  }

  return (
    <>
      {error && <FormMessage>{error}</FormMessage>}
      {shown && (
        <section role="alert" className="glass grid gap-3 rounded-[22px] p-5 ring-2 ring-primary">
          <p className="flex items-center gap-2 font-medium">
            <KeyRound className="size-4 text-primary" aria-hidden /> New key for {shown.name}. Copy it now: it won&apos;t be shown again.
          </p>
          <div className="flex gap-2">
            <input readOnly aria-label="API key" value={shown.key} onFocus={(e) => e.currentTarget.select()} className={`${fieldCls} h-11 font-mono text-sm`} />
            <Button variant="outline" aria-label="Copy key" onClick={() => navigator.clipboard.writeText(shown.key).then(() => toast.success("Key copied"))}>
              <Copy aria-hidden />
            </Button>
          </div>
          <Button variant="ghost" className="justify-self-start" onClick={() => setShown(null)}>
            I&apos;ve stored it
          </Button>
        </section>
      )}

      <section aria-labelledby="keys-h" className="grid gap-2">
        <h2 id="keys-h" className="font-medium">
          Keys ({clients.length})
        </h2>
        <ul className="grid gap-2">
          {clients.map((c) => (
            <li key={c.id} className={cn("glass grid gap-2 rounded-[20px] p-4", c.revoked && "opacity-60")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{c.keyPrefix}</span>
                {c.revoked && <Badge variant="destructive">revoked</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">{c.lastUsedAt ? `last used ${new Date(c.lastUsedAt).toLocaleString()}` : "never used"}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {c.scopes.join(", ")} · {c.brandIds === "all" ? "all brands" : c.brandIds.map(brandName).join(", ") || "no brands"}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => confirm(`Issue a new key for ${c.name}? The current key stops working immediately.`) && act(() => rotateApiKeyAction(c.id), (d) => setShown({ name: c.name, key: d.apiKey }))}
                >
                  {c.revoked ? "Re-enable with new key" : "Rotate key"}
                </Button>
                {!c.revoked && (
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => confirm(`Revoke ${c.name}? Calls with its key will fail.`) && act(() => revokeApiClientAction(c.id), () => toast.success("Revoked"))}>
                    Revoke
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="new-key-h" className="glass rounded-[22px] p-5">
        <h2 id="new-key-h" className="mb-4 font-medium">
          New API client
        </h2>
        <form
          className="grid gap-4"
          action={(f) =>
            act(
              () =>
                createApiClientAction({
                  name: String(f.get("name")),
                  source: String(f.get("source")) as "api",
                  scopes: f.getAll("scopes").map(String) as Scope[],
                  brandIds: allBrands ? "all" : f.getAll("brandIds").map(String),
                }),
              (d) => setShown({ name: d.client.name, key: d.apiKey }),
            )
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="k-name">Name</Label>
              <input id="k-name" name="name" required placeholder="e.g. zapier" className={`${fieldCls} h-11`} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="k-source">Badge on posts it creates</Label>
              <select id="k-source" name="source" defaultValue="api" className={`${fieldCls} h-11`}>
                <option value="api">API</option>
                <option value="hermes">Hermes</option>
                <option value="inqi">inqi</option>
              </select>
            </div>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Scopes</legend>
            <div className="flex flex-wrap gap-2">
              {SCOPE_INFO.map((s) => (
                <label key={s.scope} className="flex min-h-11 items-center gap-2 rounded-full border border-input bg-inset px-4 text-sm has-checked:border-primary has-checked:bg-violet-soft">
                  <input type="checkbox" name="scopes" value={s.scope} defaultChecked={s.scope === "posts:read" || s.scope === "brands:read"} className="size-4 accent-[var(--acc)]" />
                  {s.label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Brands</legend>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={allBrands} onChange={(e) => setAllBrands(e.target.checked)} className="size-4 accent-[var(--acc)]" /> All brands, including future ones
            </label>
            {!allBrands && (
              <div className="flex flex-wrap gap-2">
                {brands.map((b) => (
                  <label key={b.id} className="flex min-h-11 items-center gap-2 rounded-full border border-input bg-inset px-4 text-sm has-checked:border-primary has-checked:bg-violet-soft">
                    <input type="checkbox" name="brandIds" value={b.id} className="size-4 accent-[var(--acc)]" /> {b.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div>
            <Button type="submit" disabled={pending}>
              Create key
            </Button>
          </div>
        </form>
      </section>
    </>
  );
}
