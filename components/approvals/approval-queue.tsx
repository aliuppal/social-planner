"use client";

import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SourceIcon } from "@/components/calendar/calendar-view";
import { postOpAction } from "@/app/(app)/actions";
import { SOURCE_META, TYPE_LABEL, type Source } from "@/lib/ui/meta";
import { fieldCls } from "@/components/post/field-styles";

type Item = {
  id: string;
  brand: { name: string; color: string; timezone: string };
  type: string;
  source: string;
  caption: string;
  hashtags: string[];
  scheduledAtLocal: string | null;
  media: { url: string; mimeType: string; altText: string | null }[];
  canApprove: boolean;
};

export function ApprovalQueue({ items }: { items: Item[] }) {
  return (
    <ul className="grid gap-4">
      {items.map((i) => (
        <ApprovalCard key={i.id} item={i} />
      ))}
    </ul>
  );
}

function ApprovalCard({ item }: { item: Item }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [slide, setSlide] = useState(0);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const m = item.media[slide];

  function decide(op: "approve" | "reject") {
    start(async () => {
      const r = await postOpAction(op, { postId: item.id, comment: comment.trim() || undefined });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(op === "approve" ? "Approved" : "Sent back with your comment");
      router.refresh();
    });
  }

  return (
    <li className="glass overflow-hidden rounded-[28px]">
      <div className="flex items-center gap-2 px-4 pt-4 text-sm">
        <span aria-hidden className="size-2.5 rounded-full" style={{ background: item.brand.color }} />
        <span className="font-medium">{item.brand.name}</span>
        <span className="text-muted-foreground">· {TYPE_LABEL[item.type as keyof typeof TYPE_LABEL]}</span>
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <SourceIcon source={item.source} className="size-3.5" /> {SOURCE_META[item.source as Source].label}
        </span>
      </div>
      {m && (
        <div className="relative mx-4 mt-3 overflow-hidden rounded-[20px] bg-inset">
          {m.mimeType.startsWith("video/") ? <video src={m.url} controls playsInline className="aspect-[4/5] w-full object-cover" /> : <img src={m.url} alt={m.altText ?? ""} className="aspect-[4/5] w-full object-cover" />}
          {item.media.length > 1 && (
            <>
              <button type="button" aria-label="Previous image" disabled={slide === 0} onClick={() => setSlide((s) => s - 1)} className="absolute top-1/2 left-2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white disabled:opacity-0">
                <ChevronLeft className="size-5" aria-hidden />
              </button>
              <button type="button" aria-label="Next image" disabled={slide === item.media.length - 1} onClick={() => setSlide((s) => s + 1)} className="absolute top-1/2 right-2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white disabled:opacity-0">
                <ChevronRight className="size-5" aria-hidden />
              </button>
              <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">
                {slide + 1}/{item.media.length}
              </span>
            </>
          )}
        </div>
      )}
      <div className="grid gap-3 p-4">
        <p className="text-sm whitespace-pre-line">{item.caption || <span className="text-muted-foreground">No caption.</span>}</p>
        {item.hashtags.length > 0 && <p className="text-sm text-primary">{item.hashtags.join(" ")}</p>}
        <p className="text-xs text-muted-foreground">{item.scheduledAtLocal ? `Planned for ${item.scheduledAtLocal.slice(0, 16).replace("T", " ")} (${item.brand.timezone})` : "No time planned yet"}</p>

        {item.canApprove ? (
          rejecting ? (
            <div className="grid gap-2">
              <label htmlFor={`c-${item.id}`} className="text-sm font-medium">
                What should change?
              </label>
              <textarea id={`c-${item.id}`} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} className={`${fieldCls} py-2.5`} />
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="lg" disabled={pending} onClick={() => setRejecting(false)}>
                  Back
                </Button>
                <Button variant="destructive" size="lg" disabled={pending || !comment.trim()} onClick={() => decide("reject")}>
                  <X aria-hidden /> Send back
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="lg" disabled={pending} onClick={() => setRejecting(true)}>
                <X aria-hidden /> Reject
              </Button>
              <Button size="lg" disabled={pending} onClick={() => decide("approve")}>
                <Check aria-hidden /> Approve
              </Button>
            </div>
          )
        ) : (
          <p className="text-sm text-muted-foreground">You can view this post but not approve it.</p>
        )}
        <Link href={`/posts/${item.id}`} className="justify-self-center text-sm text-muted-foreground hover:text-foreground">
          Open full post
        </Link>
      </div>
    </li>
  );
}
