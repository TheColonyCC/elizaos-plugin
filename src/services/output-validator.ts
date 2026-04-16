/**
 * Output-quality gates for LLM-generated content before it hits
 * `createPost` / `createComment` / `sendMessage`.
 *
 * v0.16.0. Two failure modes motivated this module:
 *
 *   1. **Model-error leakage.** When Ollama (or any other upstream model
 *      provider) returns an error, the ElizaOS core plugin sometimes
 *      surfaces the error message as a plain string rather than throwing.
 *      That string then looks like valid generated content to the post
 *      client and gets posted verbatim. A real production incident:
 *      comment `622d4ba0-...` on `ff3f92e8-...` landed as
 *      `"Error generating text. Please try again later."`
 *
 *   2. **LLM artifact leakage.** Models trained with chat templates often
 *      leak their wrappers into the output — `Assistant:`, `<s>`,
 *      `[INST]`, `Sure, here's the post:`, etc. The pre-v0.16 path
 *      stripped `<response>` / `<post>` / `<text>` XML but not these
 *      softer artifacts.
 *
 * The helpers are deliberately conservative — short regexes, no LLM
 * calls. Easy to audit, cheap to run, trivial to extend when new
 * failure modes show up.
 */

/**
 * Patterns that strongly suggest the output is a model-provider error
 * message rather than real content. Anchored (mostly at the start) so
 * benign posts *discussing* errors don't trip the filter.
 *
 * Applied only to short outputs (< 500 chars) — a long substantive post
 * that happens to contain one of these phrases is almost certainly
 * legitimate and shouldn't be dropped.
 */
const MODEL_ERROR_PATTERNS: RegExp[] = [
  /^error generating (text|response|content)/i,
  /^(an )?error occurred/i,
  /^i apologize,?\s+(but|i)/i,
  /^i'?m sorry,?\s+(but|i)/i,
  /^(sorry,?\s+)?(an )?internal error/i,
  /^failed to generate/i,
  /^(could not|couldn'?t) generate/i,
  /^unable to (connect|reach|generate|respond)/i,
  /^(the )?model (is )?(unavailable|down|overloaded|offline)/i,
  /^(please )?try again later/i,
  /^request (failed|timed out|timeout)/i,
  /^rate limit(ed)? exceeded/i,
  /^service (unavailable|temporarily unavailable)/i,
  /^\[?error\]?:?\s/i,
  /^timeout/i,
];

const MODEL_ERROR_MAX_LENGTH = 500;

/**
 * True when the output looks like a model-provider error message that
 * shouldn't be published. False positives drop real content — so the
 * patterns are narrow and only fire on short inputs (error messages
 * are typically under 200 chars; 500 is a generous ceiling).
 */
export function looksLikeModelError(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > MODEL_ERROR_MAX_LENGTH) return false;
  return MODEL_ERROR_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Strip common LLM artifacts that leak past the generation prompt:
 *
 *   - Chat-template tokens: `<s>`, `</s>`, `[INST]`, `[/INST]`, `<|...|>`
 *   - Role prefixes: `Assistant:`, `AI:`, `Agent:` at the start of output
 *   - Meta-preambles: `Sure, here's…`, `Here's my reply:`, `Here is…`,
 *     `Okay, here's…`, and the "Certainly!"/"Of course!" variants
 *   - Leading `Response:`, `Output:`, `Reply:` labels
 *
 * Returns the cleaned string (possibly empty). Complements the XML
 * unwrap in `cleanGeneratedPost`.
 */
export function stripLLMArtifacts(raw: string): string {
  let text = raw.trim();

  // 1. Strip chat-template tokens anywhere in the text.
  text = text
    .replace(/<\/?s>/gi, "")
    .replace(/\[\/?(INST|SYS|SYSTEM|USER|ASSISTANT)\]/gi, "")
    .replace(/<\|[^|>]+\|>/g, "")
    .trim();

  // 2. Strip a leading role-prefix line.
  const rolePrefixRegex =
    /^(?:assistant|ai|agent|bot|model|claude|gemma|llama)\s*[:>-]\s*/i;
  text = text.replace(rolePrefixRegex, "").trim();

  // 3. Strip a leading meta-preamble on the first line only.
  //    Patterns like "Sure, here's the post:" or "Okay, here is my reply."
  //    We only drop the preamble, not the line — if the actual content
  //    follows on the same line after a colon, keep it.
  const preamblePatterns: RegExp[] = [
    /^(?:sure|certainly|of course|absolutely|okay|ok|alright|right)[,!.]?\s+(?:here(?:'?s| is)?|i(?:'?ll| will)|let me)[^.:\n]*[.:]\s*/i,
    /^here(?:'?s| is)\s+(?:my|the|your|a)[^.:\n]*[.:]\s*/i,
    /^(?:response|output|reply|answer|result|post|comment)\s*:\s*/i,
  ];
  for (const re of preamblePatterns) {
    const stripped = text.replace(re, "");
    if (stripped !== text) {
      text = stripped.trim();
      break; // don't stack multiple preamble strips on the same output
    }
  }

  return text;
}

/**
 * Combined gate: return `null` if the content should be rejected outright
 * (model error, or empty after artifact stripping). Otherwise return the
 * sanitized content.
 *
 * Callers should still run `cleanGeneratedPost` (XML/code-fence stripping)
 * — this runs *on top* of that. The recommended order:
 *
 *   1. `cleanGeneratedPost(raw)` — XML / code-fence / `<thought>` strip
 *   2. `stripLLMArtifacts(cleaned)` — role prefixes, chat tokens, preambles
 *   3. `looksLikeModelError(stripped)` — drop obvious error strings
 *
 * `validateGeneratedOutput` bundles 2 + 3 so the three autonomy clients
 * don't each reimplement the ordering.
 */
export function validateGeneratedOutput(
  cleaned: string,
): { ok: true; content: string } | { ok: false; reason: "empty" | "model_error" } {
  const stripped = stripLLMArtifacts(cleaned);
  if (!stripped) return { ok: false, reason: "empty" };
  if (looksLikeModelError(stripped)) return { ok: false, reason: "model_error" };
  return { ok: true, content: stripped };
}
