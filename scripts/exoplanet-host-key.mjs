const HOST_KEY_ALIASES = Object.freeze({
  "proxima centauri": "proxima cen",
  "tau ceti": "tau cet",
  "epsilon eridani": "eps eri",
  "epsilon indi": "eps ind a",
  "yz ceti": "yz cet",
  "luyten's star": "gj 273",
  "lalande 21185": "gj 411",
  "gliese 229": "gj 229",
  "gliese 667": "gj 667 c",
});

export function canonicalHostKey(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ");

  return HOST_KEY_ALIASES[normalized] ?? normalized;
}
