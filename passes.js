// AI passes. Each pass sends the document plus a target region and gets back
// one of three result types: hunks (edits to accept/reject), notes (detect-only),
// or draft (text to insert).

export const PASSES = [
  { id: 'outline',  label: 'Outline',       type: 'draft', auto: ['whole'],                      hint: 'Builds a structure from your title and notes.' },
  { id: 'section',  label: 'Draft section', type: 'draft', auto: ['selection', 'section'],       hint: 'Expands the selected notes, or the section under the cursor, into prose.' },
  { id: 'critique', label: 'Critique',      type: 'notes', auto: ['selection', 'whole'],         hint: 'Attacks the argument. Changes nothing.' },
  { id: 'audit',    label: 'Audit',         type: 'audit', local: true, auto: ['selection', 'whole'], hint: 'Local report: hedges, vague attributions, reform appeals, mystical State language, and more. Nothing leaves your device.' },
  { id: 'revise',   label: 'Revise',        type: 'hunks', auto: ['selection', 'section', 'whole'], hint: 'Proposes edits you accept or reject one by one.' },
];

function baseSystem(rules) {
  return `You are the adversarial editor inside a single-author essay and blog drafting tool. Output only what the pass asks for: no greeting, no commentary, no sign-off.

AUTHOR'S VOICE AND PHILOSOPHY
${rules.voiceProfile}

MECHANICAL RULES
- Passive voice in under ${rules.maxPassivePct}% of sentences.
- No two consecutive sentences open with the same word.
- At most ${rules.maxSentencesPerParagraph} sentences per paragraph.
- Em dashes: at most ${rules.maxEmDashPer1000} per 1,000 words.
- Forbidden words and phrases: ${rules.forbidden.join('; ')}.

The user message contains <title>, <document>, and sometimes <target> and <instruction>. When there is no <target>, the target is the whole document. Never invent statistics, quotes, dates, or sources. Where a fact is needed and the document does not supply it, write [verify].`;
}

const JSON_ONLY = 'Return only a JSON object. No code fence, no text before or after it.';

const PASS_TEXT = {
  outline: `PASS: Outline.
Build an outline for the piece the document describes (title, notes, any existing text). Return markdown only: one H2 per section, and under each a bullet list of the claims in the order they land, each claim a full sentence. Name the specific individuals and beneficiaries the notes supply. Mark any claim that needs a source with [verify].`,

  section: `PASS: Draft section.
The <target> holds outline entries or notes for one section; the document supplies context. Return markdown prose only. Include a heading only if the target has one. Follow every voice and mechanical rule you were given. Write [verify] where a fact is needed.`,

  critique: `PASS: Critique (detect-only).
Attack the argument inside the target. Find unsupported claims, factual assertions that need a source, logical gaps, equivocations, places that contradict the author's own axioms, and passages that drift from the voice. State the strongest objection a smart opponent would raise in "objection". Each note quotes an exact substring of the target (200 characters or fewer) in "quote". Do not rewrite anything. At most 15 notes, most severe first. "kind" is one of claim, logic, voice, fact; "severity" is high, medium, or low.
${JSON_ONLY}
Shape: {"objection": "string", "notes": [{"quote": "string", "issue": "string", "severity": "high", "kind": "claim"}]}`,

  revise: `PASS: Revise.
Propose edits inside the target. Fix rule violations, cut fluff, tighten, and replace vague claims with specifics only when the document already supplies them. Preserve the author's meaning and markdown syntax. Each hunk has "find", an exact verbatim substring of the target that appears only once in the document; "replace", the new text; and "reason", one short clause. Prefer sentence-sized hunks. Hunks must not overlap. At most 25. If nothing needs changing, return {"hunks": []}.
${JSON_ONLY}
Shape: {"hunks": [{"find": "string", "replace": "string", "reason": "string"}]}`,
};

export function buildRequest(pass, { title, doc, target, whole, instruction, rules }) {
  if (pass.local) throw new Error(`${pass.label} runs on this device and has no model prompt.`);
  const system = `${baseSystem(rules)}\n\n${PASS_TEXT[pass.id]}`;
  let user = `<title>${title || '(untitled)'}</title>\n<document>\n${doc}\n</document>`;
  if (!whole) user += `\n<target>\n${target}\n</target>`;
  if (instruction) user += `\n<instruction>\n${instruction}\n</instruction>`;
  return { system, user };
}

// Paste mode: the Claude Project already holds the voice and rules, so the
// prompt carries only the pass instructions and the content.
export function buildPastePrompt(pass, { title, doc, target, whole, instruction }) {
  if (pass.local) throw new Error(`${pass.label} runs on this device and has no model prompt.`);
  let out = `${PASS_TEXT[pass.id]}\n\nUse the voice, philosophy, and rules from this Project's instructions. Output only what this pass asks for.\n\n<title>${title || '(untitled)'}</title>\n<document>\n${doc}\n</document>`;
  if (!whole) out += `\n<target>\n${target}\n</target>`;
  if (instruction) out += `\n<instruction>\n${instruction}\n</instruction>`;
  return out;
}

// Paste this once into the Claude Project's instructions.
export function projectSetupText(rules) {
  return `${baseSystem(rules)}

HOW THIS PROJECT WORKS
Each message I send begins with "PASS:" and a pass name, then the pass instructions, then tagged content. Follow the pass instructions exactly and output only what they ask for. Where a pass asks for JSON, return a single JSON object and nothing else. Where it asks for markdown, return only the markdown. Do not ask me questions mid-pass.`;
}

export async function callClaude(settings, { system, user, signal }) {
  const body = {
    model: settings.model,
    max_tokens: Number(settings.maxTokens) || 16000,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (settings.effort && !/haiku/i.test(settings.model)) body.output_config = { effort: settings.effort };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  let data;
  try { data = await res.json(); } catch { throw new Error(`API returned ${res.status} with no readable body.`); }
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `API error ${res.status}`);

  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, stop: data.stop_reason, usage: data.usage };
}

function extractJson(t) {
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('No JSON object in the response.');
  return JSON.parse(t.slice(s, e + 1));
}

export function parseResult(pass, text) {
  if (pass.type === 'draft') {
    let t = text.trim();
    const fenced = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
    if (fenced) t = fenced[1].trim();
    return { text: t };
  }
  const json = extractJson(text);
  if (pass.type === 'hunks') {
    const hunks = (Array.isArray(json.hunks) ? json.hunks : [])
      .filter((h) => h && typeof h.find === 'string' && h.find && typeof h.replace === 'string' && h.find !== h.replace)
      .map((h, i) => ({ id: `h${i}`, find: h.find, replace: h.replace, reason: String(h.reason || ''), status: 'pending' }));
    return { hunks };
  }
  const notes = (Array.isArray(json.notes) ? json.notes : [])
    .filter((n) => n && typeof n.issue === 'string' && n.issue)
    .map((n, i) => ({
      id: `n${i}`,
      quote: typeof n.quote === 'string' ? n.quote : '',
      issue: n.issue,
      severity: ['high', 'medium', 'low'].includes(n.severity) ? n.severity : 'medium',
      kind: String(n.kind || ''),
      dismissed: false,
    }));
  return { objection: String(json.objection || ''), notes };
}
