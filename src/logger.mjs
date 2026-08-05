/**
 * Structured logging for the broker (pino).
 * -----------------------------------------
 * Every find_tools decision and run_tool call is logged as one JSON line, so the
 * broker's choices are auditable after the fact — the "see and overrule every
 * call" premise, made durable.
 *
 * Two streams: a JSONL file (durable, private, gitignored; also future mining
 * input) and stderr (live view). NEVER stdout — on the stdio transport that is
 * the MCP JSON-RPC channel and logging there would corrupt the protocol.
 *
 * We log tool identity and outcomes, not tool args or results, and redact common
 * secret fields defensively. Level via LOG_LEVEL (default "info").
 */
import pino from "pino";

/** @param {string} logPath JSONL destination */
export function createLogger(logPath) {
  const file = pino.destination({ dest: logPath, mkdir: true, sync: false });
  const streams = [
    { stream: file },
    { stream: process.stderr }, // stderr, not stdout (stdio transport uses stdout)
  ];
  return pino(
    {
      name: "toolgate",
      level: process.env.LOG_LEVEL || "info",
      redact: { paths: ["args", "*.args", "token", "*.token", "authorization", "*.authorization", "headers.authorization"], remove: true },
    },
    pino.multistream(streams),
  );
}
