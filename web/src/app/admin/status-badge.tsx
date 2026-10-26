import { Badge } from "@/components/ui/badge"

const tone: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  paid: "default",
  delivered: "default",
  succeeded: "default",
  applied: "default",
  dead: "destructive",
  blocked: "destructive",
  failed: "destructive",
  rejected: "destructive",
  expired: "secondary",
  cancelled: "secondary",
  refunded: "secondary",
}

/** The status text is always shown; color only reinforces it. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={tone[status] ?? "outline"}>
      {status.replaceAll("_", " ")}
    </Badge>
  )
}
