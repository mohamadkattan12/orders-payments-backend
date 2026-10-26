import { AlertCircleIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

/** Loading, error and empty states shared by every panel. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  )
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <Alert variant="destructive">
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>Couldn&apos;t load this</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
      {children}
    </p>
  )
}

/** Loading → error → empty → content, in that order. */
export function DataState<T>({
  data,
  error,
  loading,
  reload,
  isEmpty,
  empty,
  children,
}: {
  data: T | undefined
  error?: string
  loading: boolean
  reload: () => void
  isEmpty: (data: T) => boolean
  empty: React.ReactNode
  children: (data: T) => React.ReactNode
}) {
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (data === undefined) return loading ? <Loading /> : null
  if (isEmpty(data)) return <Empty>{empty}</Empty>
  return <>{children(data)}</>
}
