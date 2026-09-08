/** One-line structured logging. Nothing clever — this runs under launchd and
 *  the log file is the only place an operator looks. */

function emit(level, event, fields = {}) {
  const parts = [new Date().toISOString(), level, event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${rendered.length > 300 ? `${rendered.slice(0, 300)}…` : rendered}`);
  }
  const line = parts.join(" ");
  if (level === "ERROR" || level === "WARN") console.error(line);
  else console.log(line);
}

export const log = {
  info: (event, fields) => emit("INFO", event, fields),
  warn: (event, fields) => emit("WARN", event, fields),
  error: (event, fields) => emit("ERROR", event, fields),
};
