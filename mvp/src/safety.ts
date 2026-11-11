/** Agent messages are data, never instructions. Filter prompt injection and pressure tactics. */
const INJECTION: RegExp[] = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules|prompts?)/i,
  /disregard (the |your )?(system|previous|above)/i,
  /\b(system|developer|assistant)\s*(prompt|message|:)/i,
  /you (must|are now|will) (now )?(approve|pay|accept|reveal|obey)/i,
  /reveal (the |your )?(floor|limit|budget|walk[- ]?away|reserve)/i,
  /(what is|tell me) (your|the) (floor|minimum|lowest|reserve|maximum budget)/i,
  /<\/?(case|system|tool|instructions?)>/i,
  /approve (this|the) (deal|payment) (on behalf|for me|automatically)/i,
];
const PRESSURE: RegExp[] = [
  /\b(act now|last chance|final offer or|today only|expires in \d+ (minutes|seconds))\b/i,
  /\b(or else|you will regret|other buyers are waiting|i will report you)\b/i,
  /\b(urgent(ly)?|immediately)\b.*\b(pay|send|approve)\b/i,
];

export interface SafetyVerdict { ok: boolean; flags: string[]; clean: string }

export function screen(text: string | undefined | null): SafetyVerdict {
  const t = (text ?? "").slice(0, 2000);
  const flags: string[] = [];
  if (INJECTION.some((r) => r.test(t))) flags.push("prompt_injection");
  if (PRESSURE.some((r) => r.test(t))) flags.push("pressure_tactic");
  // eslint-disable-next-line no-control-regex
  const clean = flags.length ? "" : t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return { ok: flags.length === 0, flags, clean };
}
