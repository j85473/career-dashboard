import { createHash } from 'node:crypto';

export const MAX_MANDATORY_REQUIREMENT_CANDIDATES = 32;

export type MandatoryRequirementCandidateSource =
  | 'explicit_section'
  | 'mandatory_language'
  | 'core_function';

export type MandatoryRequirementCandidate = {
  requirementId: string;
  text: string;
  originalText: string;
  classification: 'required' | 'preferred';
  sourceSection: 'REQUIRED EXPERIENCE' | 'PREFERRED EXPERIENCE' | 'ROLE-DEFINING QUALIFICATIONS' | 'OTHER';
  source: MandatoryRequirementCandidateSource;
  sourceSpan: { start: number; end: number };
  mandatoryByText: boolean;
};

const MANDATORY_HEADING = /^(?:required experience|required qualifications?|minimum qualifications?|basic qualifications?|minimum requirements?|requirements?|qualifications?|role-defining qualifications?|what you(?:'|’)ll bring|what you will bring|what you bring|what we(?:'|’)re looking for|who you are|skills and experience|abilities)\s*:?[\s]*$/i;
const PREFERRED_HEADING = /^(?:preferred(?: experience| qualifications?)?|desired(?: experience| qualifications?)?|nice to have|bonus(?: points)?|ideal candidate)\s*:?[\s]*$/i;
const CREDENTIAL_HEADING = /^role-defining qualifications?\s*:?\s*$/i;
const STOP_HEADING = /^(?:(?:responsibilities(?: include)?|ai\s*&\s*hiring integrity|benefits(?:\s*&\s*perks| and perks)?|equal opportunity|working at|why|our)\b|(?:what you(?:'|’)ll do|what you will do|the role|role overview|about(?: us| the role)?|compensation|salary|perks)\s*:?[\s]*$)/i;
const PACKET_IGNORED_HEADING = /^(?:work location and travel|compensation)\s*:?[\s]*$/i;
const MANDATORY_LANGUAGE = /\b(?:must|requires?|required|required experience|required qualifications?|minimum qualifications?|minimum of|at least|\d+(?:\.\d+)?\+?\s+years?|bachelor(?:'s|’s)?(?: degree)?|ability to travel|willing(?:ness)? to travel)\b/i;
const PREFERENCE_LANGUAGE = /\b(?:preferred|ideally|nice to have|bonus|a plus|as many of the following as possible)\b/i;
const NON_MANDATORY_LANGUAGE = /\b(?:not required|is optional|are optional|no [^.]{0,60} required)\b/i;
const OPTIONAL_LIST_INTRODUCTION = /\b(?:as many of the following as possible|ideal candidate.{0,80}(?:following|competitive)|candidates? strong on \w+ of (?:the )?\w+|preferred (?:skills|experience|qualifications?).{0,40}(?:include|are|following))\b/i;

function normalizedRequirement(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/^[\s\-*•‣▪◦]+/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;:,]+$/g, '')
    .toLocaleLowerCase('en-US');
}

function candidateId(text: string, classification: 'required' | 'preferred'): string {
  return `req-${createHash('sha256').update(`${classification}\u0000${normalizedRequirement(text)}`, 'utf8').digest('hex').slice(0, 24)}`;
}

function cleanRequirementLine(value: string): string {
  return value
    .replace(/^[\s\-*•‣▪◦]+/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeHeading(value: string): boolean {
  const line = value.trim();
  if (!line || line.length > 100) return false;
  if (/:$/.test(line)) return true;
  if (/^[A-Z][A-Z\s&/–—-]{2,}$/.test(line)) return true;
  return /^(?:[A-Z][\p{L}&/–—-]+\s*){1,6}$/u.test(line) && !/[.!?]$/.test(line);
}

type LocatedLine = { raw: string; trimmed: string; start: number; end: number };

function atomicClauses(value: string): string[] {
  const cleaned = cleanRequirementLine(value);
  const clauses = cleaned.split(/\s*;\s*|\s*,\s+(?=(?:and\s+)?(?:\d|experience\b|knowledge\b|proficien|fluency\b|ability\b|willingness\b|track\b|valid\b|active\b|current\b|a\s+(?:valid|active|current)\b|an\s+(?:active|current)\b))/i)
    .flatMap((clause) => (
      /\b(?:driver(?:'s)? licen[cs]e|driving record|work authori[sz]ation)\b/i.test(clause)
        ? clause.split(/\s*,\s+and\s+(?=(?:customer relations|b2b sales|sales experience)\b)/i)
        : [clause]
    ))
    .map((clause) => cleanRequirementLine(clause).replace(/^and\s+/i, ''))
    .filter(Boolean);
  return clauses.length > 1 ? clauses : [cleaned];
}

function locatedLines(description: string): LocatedLine[] {
  const result: LocatedLine[] = [];
  let offset = 0;
  for (const raw of description.split('\n')) {
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    result.push({
      raw,
      trimmed: raw.trim(),
      start: offset + leading,
      end: offset + raw.length - trailing,
    });
    offset += raw.length + 1;
  }
  return result;
}

function sentenceCandidates(description: string, baseOffset = 0): Array<{ text: string; start: number; end: number }> {
  const result: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /[^.!?\n]+(?:[.!?]+|$)/g;
  for (const match of description.matchAll(pattern)) {
    const raw = match[0];
    const text = cleanRequirementLine(raw);
    if (
      !text
      || !MANDATORY_LANGUAGE.test(text)
      || PREFERENCE_LANGUAGE.test(text)
      || NON_MANDATORY_LANGUAGE.test(text)
    ) continue;
    const leading = raw.length - raw.trimStart().length;
    const start = baseOffset + (match.index || 0) + leading;
    result.push({ text, start, end: start + raw.trim().length });
  }
  return result;
}

/**
 * Builds a deterministic, hash-bound coverage checklist from the exact JD text
 * sent to Agy. Explicit mandatory sections win; mandatory prose outside those
 * sections is added in source order. Nothing is silently truncated.
 */
export function extractMandatoryRequirementCandidates(
  description: string,
  title: string,
): MandatoryRequirementCandidate[] {
  const candidates: MandatoryRequirementCandidate[] = [];
  const seen = new Set<string>();
  let section: 'mandatory' | 'preferred' | 'credential' | 'ignored' | 'other' = 'other';

  const add = (
    textValue: string,
    originalTextValue: string,
    classification: 'required' | 'preferred',
    sourceSection: MandatoryRequirementCandidate['sourceSection'],
    source: MandatoryRequirementCandidateSource,
    sourceSpan: { start: number; end: number },
    mandatoryByText: boolean,
  ) => {
    const text = cleanRequirementLine(textValue);
    const originalText = cleanRequirementLine(originalTextValue);
    const normalized = normalizedRequirement(text);
    const identity = `${classification}\u0000${normalized}`;
    if (!normalized || normalized === 'not stated' || seen.has(identity)) return;
    if (text.length > 500) {
      throw new Error('mandatory requirement candidate exceeds 500 characters');
    }
    seen.add(identity);
    candidates.push({
      requirementId: candidateId(text, classification),
      text,
      originalText,
      classification,
      sourceSection,
      source,
      sourceSpan,
      mandatoryByText,
    });
  };

  for (const line of locatedLines(description)) {
    if (!line.trimmed) continue;
    if (PACKET_IGNORED_HEADING.test(line.trimmed)) {
      section = 'ignored';
      continue;
    }
    if (CREDENTIAL_HEADING.test(line.trimmed)) {
      section = 'credential';
      continue;
    }
    if (MANDATORY_HEADING.test(line.trimmed)) {
      section = 'mandatory';
      continue;
    }
    if (PREFERRED_HEADING.test(line.trimmed)) {
      section = 'preferred';
      continue;
    }
    if (section === 'mandatory' && OPTIONAL_LIST_INTRODUCTION.test(line.trimmed)) {
      section = 'preferred';
      continue;
    }
    if (STOP_HEADING.test(line.trimmed)) {
      section = 'other';
      continue;
    }
    if (section === 'ignored') continue;
    // Within an explicitly mandatory section, an unfamiliar title-cased line
    // is safer to assess as a requirement than to treat as an implicit section
    // boundary. Known preferred/stop headings above still end the section.
    if (section !== 'mandatory' && section !== 'preferred' && section !== 'credential' && looksLikeHeading(line.trimmed)) {
      section = 'other';
      continue;
    }
    if (
      section === 'mandatory'
      && !PREFERENCE_LANGUAGE.test(line.trimmed)
      && !NON_MANDATORY_LANGUAGE.test(line.trimmed)
    ) {
      for (const clause of atomicClauses(line.trimmed)) {
        add(clause, line.trimmed, 'required', 'REQUIRED EXPERIENCE', 'explicit_section', { start: line.start, end: line.end }, true);
      }
    } else if (section === 'preferred' && !NON_MANDATORY_LANGUAGE.test(line.trimmed)) {
      for (const clause of atomicClauses(line.trimmed)) {
        add(clause, line.trimmed, 'preferred', 'PREFERRED EXPERIENCE', 'explicit_section', { start: line.start, end: line.end }, false);
      }
    } else if (section === 'credential' && !NON_MANDATORY_LANGUAGE.test(line.trimmed)) {
      const preferred = /^(?:preferred verification item|preferred)\s*:/i.test(line.trimmed);
      const stripped = line.trimmed.replace(/^(?:required|preferred) verification item\s*:\s*/i, '');
      for (const clause of atomicClauses(stripped)) {
        add(clause, line.trimmed, preferred ? 'preferred' : 'required', 'ROLE-DEFINING QUALIFICATIONS', 'explicit_section', { start: line.start, end: line.end }, !preferred);
      }
    } else {
      for (const sentence of sentenceCandidates(line.raw, line.start)) {
        for (const clause of atomicClauses(sentence.text)) {
          add(clause, sentence.text, 'required', 'OTHER', 'mandatory_language', { start: sentence.start, end: sentence.end }, true);
        }
      }
    }
  }

  candidates.sort((left, right) => (
    left.sourceSpan.start - right.sourceSpan.start
    || left.sourceSpan.end - right.sourceSpan.end
  ));

  if (candidates.length > MAX_MANDATORY_REQUIREMENT_CANDIDATES) {
    throw new Error(
      `JD exposes ${candidates.length} mandatory requirement candidates; maximum is ${MAX_MANDATORY_REQUIREMENT_CANDIDATES}`,
    );
  }
  if (candidates.length > 0) return candidates;

  const fallback = `Primary core function of the ${cleanRequirementLine(title) || 'assigned role'}`;
  return [{
    requirementId: candidateId(fallback, 'required'),
    text: fallback,
    originalText: fallback,
    classification: 'required',
    sourceSection: 'OTHER',
    source: 'core_function',
    sourceSpan: { start: 0, end: 0 },
    mandatoryByText: false,
  }];
}

export function mandatoryRequirementCandidatesMatch(
  left: readonly MandatoryRequirementCandidate[],
  right: readonly MandatoryRequirementCandidate[],
): boolean {
  return left.length === right.length && left.every((candidate, index) => (
    candidate.requirementId === right[index]?.requirementId
    && candidate.text === right[index]?.text
    && candidate.originalText === right[index]?.originalText
    && candidate.classification === right[index]?.classification
    && candidate.sourceSection === right[index]?.sourceSection
    && candidate.source === right[index]?.source
    && candidate.sourceSpan.start === right[index]?.sourceSpan.start
    && candidate.sourceSpan.end === right[index]?.sourceSpan.end
    && candidate.mandatoryByText === right[index]?.mandatoryByText
  ));
}
