/*
 * Strict single-mailbox syntax (R1.6B): exactly one bare ASCII addr-spec,
 * `dot-atom@domain` with LDH labels. No display name, quotes, comments,
 * groups, lists, address literals, whitespace or control characters; local
 * part ≤ 64, whole address ≤ 254. Dependency-free so configuration
 * validation and the mail adapter share it without coupling.
 */

const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const ADDR_SPEC = new RegExp(`^(${ATEXT}+(?:\\.${ATEXT}+)*)@((?:${LABEL}\\.)+${LABEL})$`);

export function isStrictMailbox(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254) {
    return false;
  }

  const match = ADDR_SPEC.exec(value);
  return match !== null && match[1]!.length <= 64;
}
