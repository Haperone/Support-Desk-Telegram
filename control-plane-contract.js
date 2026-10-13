export const CONTROL_PLANE_CONTEXT = Symbol.for("freeflare.control-plane-context");

export const GENERAL_COMMANDS = Object.freeze([
  "/menu", "/help", "/messages", "/panel", "/info", "/close", "/open", "/delete", "/risk", "/antispam",
  "/bots",
  "/addbot",
  "/selfcheck",
  "/attack",
  "/users",
  "/user",
  "/audit",
  "/reactions",
  "/operators",
  "/topicstyle",
  "/plan",
  "/storage",
  "/ban",
  "/unban",
  "/restrict",
  "/unrestrict",
  "/trust",
  "/untrust",
  "/riskreset",
  "/cancel",
]);

const GENERAL_COMMAND_SET = new Set(GENERAL_COMMANDS);

export function isGeneralCommand(command) {
  return GENERAL_COMMAND_SET.has(command);
}

export function stablePendingNonce(seed, params = []) {
  const text = [seed, params[0], params[3], params[4], params[5]]
    .map((value) => String(value ?? ""))
    .join("|");
  let hash = 1469598103934665603n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(36).padStart(13, "0");
}
