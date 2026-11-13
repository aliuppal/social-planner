/** Instant skeleton while a signed-in page streams in (lets navigations render immediately). */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid gap-3">
      <div className="h-8 w-48 animate-pulse rounded-full bg-muted" />
      <div className="h-4 w-72 animate-pulse rounded-full bg-muted" />
      <div className="glass mt-4 h-[60vh] animate-pulse rounded-[22px]" />
    </div>
  );
}
