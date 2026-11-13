import type { Metadata } from "next";
import { requireOwner } from "@/lib/auth/session";
import { NewBrandForm } from "@/components/brand/brand-forms";

export const metadata: Metadata = { title: "New brand · Social Planner" };

export default async function NewBrandPage() {
  await requireOwner();
  return (
    <div className="mx-auto grid max-w-xl gap-4">
      <h1 className="text-2xl font-semibold">New brand</h1>
      <NewBrandForm />
    </div>
  );
}
