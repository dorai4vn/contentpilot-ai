import { Skeleton } from "../../../_components/ui";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Đang tải" className="space-y-4" data-testid="loading">
      <p className="sr-only">Đang tải…</p>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
