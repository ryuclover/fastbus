/** JSON requests from the interface; authentication stays in same-origin cookies. */
export async function api<T>(
  path: string,
  method = "GET",
  input?: unknown,
  fallback = "Não foi possível concluir a operação.",
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers:
      input === undefined ? undefined : { "Content-Type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || fallback), {
      status: response.status,
    });
  return result as T;
}
