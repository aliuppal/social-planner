import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Label + input + optional error, wired for screen readers. */
export function Field({ id, label, error, hint, ...props }: React.ComponentProps<typeof Input> & { id: string; label: string; error?: string; hint?: string }) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...props} />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function FormMessage({ tone = "error", children }: { tone?: "error" | "success"; children: React.ReactNode }) {
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-[14px] px-3.5 py-2.5 text-sm ${tone === "error" ? "bg-destructive/10 text-destructive" : "bg-teal-soft text-teal"}`}>
      {children}
    </p>
  );
}
