/** The browser calls the API directly; the admin key travels only in the X-Admin-Key header. */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8100"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export async function api<T>(
  path: string,
  key: string,
  body?: object
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "X-Admin-Key": key,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    })
  } catch {
    throw new ApiError(
      0,
      `Can't reach the API at ${API_URL}. Check that it is running.`
    )
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = Array.isArray(json.message)
      ? json.message.join("; ")
      : (json.message ?? `Request failed (HTTP ${res.status}).`)
    throw new ApiError(res.status, message)
  }
  return json as T
}
