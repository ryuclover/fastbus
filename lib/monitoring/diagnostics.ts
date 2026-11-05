export function diagnosticCode(error: unknown, fallback = "QUERY_FAILED") {
  const message = error instanceof Error ? error.message : "";
  if (/^[A-Z][A-Z0-9_]{0,79}$/.test(message)) return message;
  if (/Timeout|timed out|timeout|Waiting failed/.test(message))
    return "BROWSER_TIMEOUT";
  if (/Target.*closed|Failed to launch|GPU process/i.test(message))
    return "BROWSER_LAUNCH_FAILED";
  if (/ERR_PROXY|ERR_TUNNEL|ERR_CONNECTION|ERR_NAME/.test(message))
    return "NETWORK_UNAVAILABLE";
  if (/ENOENT|executable.*exist|browser.*not found/i.test(message))
    return "BROWSER_NOT_FOUND";
  return fallback;
}
