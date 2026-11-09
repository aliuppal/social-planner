import { CalendarDays, CheckCircle2, LayoutGrid, Bot, ShieldCheck } from "lucide-react";

const pillars = [
  { icon: CalendarDays, label: "Calendar", text: "Every brand, every post, in its own timezone." },
  { icon: CheckCircle2, label: "Approvals", text: "Clients approve or reject from any phone." },
  { icon: Bot, label: "Agents", text: "Hermes and inqi plan and schedule over MCP." },
  { icon: ShieldCheck, label: "Publishing", text: "Posts go live on the minute, never twice." },
];

/** Placeholder until the app shell lands in phase 4. Shows the inqi theme. */
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-[1040px] flex-1 flex-col px-[clamp(18px,4vw,40px)] py-8">
      <header className="flex items-center justify-between">
        <span className="text-2xl font-bold tracking-tight">
          planner<span className="text-primary">.</span>
        </span>
        <span className="glass rounded-full px-4 py-2 text-sm text-muted-foreground">Phase 1 · service layer</span>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center gap-6 py-16 text-center">
        <div
          aria-hidden
          className="size-28 rounded-full shadow-[0_0_60px_#8b7bff55]"
          style={{ background: "radial-gradient(circle at 35% 30%, #fff 0, #c9c2ff 18%, #8b7bff 55%, #3ddcbc 100%)" }}
        />
        <h1 className="text-balance text-3xl font-semibold sm:text-4xl">What should go out next?</h1>
        <p className="max-w-[46ch] text-muted-foreground">
          One planner for every Instagram brand you run. Calendars, approvals and on-time publishing for you, your clients and your agents.
        </p>
      </section>

      <ul className="grid gap-3 pb-8 sm:grid-cols-2">
        {pillars.map(({ icon: Icon, label, text }) => (
          <li key={label} className="glass flex items-start gap-3 rounded-[22px] p-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-violet-soft text-primary">
              <Icon className="size-4" aria-hidden />
            </span>
            <span>
              <span className="block font-medium">{label}</span>
              <span className="text-sm text-muted-foreground">{text}</span>
            </span>
          </li>
        ))}
      </ul>

      <footer className="flex items-center justify-center gap-2 pb-4 text-xs text-muted-foreground">
        <LayoutGrid className="size-3.5" aria-hidden /> Sign-in arrives in phase 2.
      </footer>
    </main>
  );
}
