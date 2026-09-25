/**
 * Learning which spellings name the same employer, and keeping every card's
 * canonical employer current.
 *
 * ## Evidence
 *
 * Spellings that differ only in formatting share an alias key and need no
 * evidence (`employerAliasKey`). Anything else is joined only when the names
 * plainly relate (`employerNameRelation`) and the pipeline has seen proof:
 *
 * - site: both spellings came from the same employer site or ATS board;
 * - posting: the same posting (same title, 90%+ identical text, no location
 *   contradiction) arrived under both spellings.
 *
 * A name relation without evidence is not enough ("Spectrum" is not
 * "Spectrum Brands"), and evidence without a name relation is refused: on
 * 2026-09-25 identical postings linked reposters ("remote nova" copying HPE),
 * subsidiaries (Elavon under U.S. Bank) and sister brands (Timberland under
 * VF). Names that relate only through a two- or three-letter name ("HP",
 * "GE") need site evidence or two separate postings.
 *
 * ## Authority
 *
 * Joseph's corrections, the reviewed display profiles and the reviewed
 * cooldown groups are pins: a learned link never joins two spellings pinned to
 * different names, and a pinned name is always the group's name. Every group
 * member must relate to the group's name directly, so a chain of links cannot
 * drift from one employer to another.
 *
 * Learned rules are replaced wholesale on each learning pass; a bad pass can
 * be undone by deleting the `learned` rows, and Joseph's rules are never
 * touched.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { REVIEWED_EMPLOYER_URL_NAMES } from './companyNameStandardization';
import { COMPANY_EMPLOYER_URL_RULE, employerUrlKey } from './employerUrl';
import { COMPANY_DISPLAY_PROFILES } from './companyPresentation';
import {
  EMPLOYER_LABEL_RULE,
  EMPLOYER_NAME_RULE,
  LEARNED_RULE_ORIGIN,
  employerAliasKey,
  employerLabel,
  employerLabelKey,
  employerNameRelation,
  presentableEmployerName,
  resolveEmployer,
  type NameRelation,
} from './employerIdentity';
import { loadEmployerRuleIndex } from './employerRuleStore';
import { prisma } from './prisma';
import { judgeSameJob, sameJobTitleKey, type SameJobSubject } from './sameJobMatch';

/** Reviewed employer groups that predate the learner; they pin names. */
export const REVIEWED_EMPLOYER_GROUPS: ReadonlyArray<{ name: string; aliases: readonly string[] }> = [
  ...COMPANY_DISPLAY_PROFILES.map((profile) => ({ name: profile.name, aliases: profile.aliases })),
];

export const EMPLOYER_POSTING_CONTAINMENT = 0.9;

/** Cards whose employer matters: everything Joseph can see or decided, and scored history. */
export const EMPLOYER_CARD_WHERE: Prisma.JobWhereInput = {
  OR: [
    { status: { in: ['inbox', 'pending_af', 'bookmarked', 'cooldown', 'applied', 'interviewing', 'passed', 'expired'] } },
    { status: 'dismissed', scoringStatus: { in: ['scored', 'failed'] } },
  ],
};

// ---------------------------------------------------------------------------
// Planning (pure)

export type LabelObservation = { company: string; source: string | null; urlKeys: readonly string[]; rows: number };
export type PostingLink = { left: string; right: string; jobIds: readonly [string, string]; containment: number };
export type EmployerPin = { key: string; name: string };
/** Joseph pinned this exact spelling; it forms its own group. */
export type EmployerLabelPin = { label: string; name: string };

type Node = {
  key: string;
  labels: Map<string, { rows: number; aggregatorRows: number; sources: Set<string> }>;
  urlKeys: Set<string>;
  pin: string | null;
};

type Edge = { left: string; right: string; relation: NameRelation | null; site: number; postings: Set<string> };

export type LearnedEmployerRule = {
  matchType: string;
  matchKey: string;
  standardName: string;
  evidence: Prisma.InputJsonValue;
};

export type EmployerLearningPlan = {
  rules: LearnedEmployerRule[];
  /** Groups of two or more spellings, for review. */
  groups: Array<{ name: string; labels: string[]; pinned: boolean }>;
  /** Evidence that was not allowed to join two spellings, for review. */
  refused: Array<{ left: string; right: string; reason: 'names_unrelated' | 'needs_more_evidence' | 'pinned_apart' | 'not_related_to_group_name'; site: number; postings: number }>;
};

function labelQuality(raw: string): number {
  const label = employerLabel(raw);
  if (/\.wd\d+/i.test(raw) || /myworkday/i.test(raw)) return 0;
  if (/^[a-z0-9][a-z0-9-]*$/.test(label)) return 1;
  if (label.length > 4 && label === label.toUpperCase() && /[A-Z]/.test(label)) return 2;
  if (label !== String(raw).trim().replace(/\s+/g, ' ')) return 2;
  return 3;
}

function bestLabel(node: Node): string {
  return [...node.labels.entries()].sort(([a, left], [b, right]) => labelQuality(b) - labelQuality(a)
    || right.aggregatorRows - left.aggregatorRows
    || right.rows - left.rows
    || presentableEmployerName(a).length - presentableEmployerName(b).length
    || a.localeCompare(b))[0][0];
}

/**
 * The name a group of spellings goes by: the brand most spellings contain
 * ("IQVIA" over "IUK IQVIA IES UK", "Paycom" over "Paycom Online"), as
 * aggregators write it, without "The"/"Company" padding. A Workday tenant
 * ("fortrea") contributes its name only as some real label spells it
 * ("FTINC Fortrea Inc." gives "Fortrea").
 */
function canonicalFor(nodes: readonly Node[]): string {
  const labels = new Map<string, { rows: number; aggregatorRows: number; sources: Set<string> }>();
  for (const node of nodes) for (const [label, stats] of node.labels) {
    const current = labels.get(label);
    labels.set(label, current
      ? { rows: current.rows + stats.rows, aggregatorRows: current.aggregatorRows + stats.aggregatorRows, sources: new Set([...current.sources, ...stats.sources]) }
      : stats);
  }
  const usable = [...labels.keys()].filter((label) => labelQuality(label) >= 2);
  const candidates = new Map<string, { aggregatorRows: number; rows: number }>();
  const add = (name: string, stats: { aggregatorRows: number; rows: number }) => {
    if (!name) return;
    const current = candidates.get(name) || { aggregatorRows: 0, rows: 0 };
    candidates.set(name, { aggregatorRows: current.aggregatorRows + stats.aggregatorRows, rows: current.rows + stats.rows });
  };
  for (const [label, stats] of labels) {
    if (labelQuality(label) >= 2) {
      add(presentableEmployerName(label, [...stats.sources][0] ?? null), stats);
      continue;
    }
    const slug = employerLabel(label);
    for (const other of usable) {
      const word = other.split(/[^\p{L}\p{N}]+/u).find((part) => part.toLowerCase() === slug);
      if (word) { add(word, { aggregatorRows: 0, rows: stats.rows }); break; }
    }
  }
  if (candidates.size === 0) {
    const label = bestLabel({ key: '', labels, urlKeys: new Set(), pin: null });
    return presentableEmployerName(label, [...(labels.get(label)?.sources || [])][0] ?? null) || label;
  }
  // Spellings that differ only in formatting compete as one choice, shown in
  // their plainest form ("Scotts Miracle-Gro", not "The Scotts Miracle-Gro Company").
  const plain = (name: string) => (name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '') === employerAliasKey(name) ? 1 : 0);
  const byKey = new Map<string, { names: Array<{ name: string; aggregatorRows: number; rows: number }>; aggregatorRows: number; rows: number }>();
  for (const [name, stats] of candidates) {
    const key = employerAliasKey(name);
    if (!key) continue;
    const group = byKey.get(key) || { names: [], aggregatorRows: 0, rows: 0 };
    group.names.push({ name, ...stats });
    group.aggregatorRows += stats.aggregatorRows;
    group.rows += stats.rows;
    byKey.set(key, group);
  }
  const ranked = (keys: number[][]) => (left: number, right: number) => {
    for (let index = 0; index < keys[left].length; index += 1) {
      if (keys[left][index] !== keys[right][index]) return keys[right][index] - keys[left][index];
    }
    return 0;
  };
  const choices = [...byKey.entries()].map(([key, group]) => {
    const forms = group.names.map((form) => [plain(form.name), form.aggregatorRows, /\s/.test(form.name) ? 1 : 0, labelQuality(form.name), form.rows]);
    const order = group.names.map((_, index) => index).sort(ranked(forms));
    return { key, name: group.names[order[0]].name, aggregatorRows: group.aggregatorRows, rows: group.rows };
  });
  // Coverage counts real labels only; a tenant slug must not vote for itself.
  const coverage = (key: string) => {
    let total = 0;
    for (const [label, stats] of labels) if (labelQuality(label) >= 2 && employerAliasKey(label).includes(key)) total += stats.rows;
    return total;
  };
  // The name aggregators use most is the public brand; then the name most
  // spellings contain; then the shorter.
  const keys = choices.map((choice) => [choice.aggregatorRows, coverage(choice.key), -choice.name.length, choice.rows]);
  const order = choices.map((_, index) => index).sort((left, right) => ranked(keys)(left, right)
    || choices[left].name.localeCompare(choices[right].name));
  return choices[order[0]].name;
}

const RELATION_RANK: Readonly<Record<NameRelation, number>> = { same: 3, strong: 2, short: 1 };

export function planEmployerLearning(input: {
  labels: readonly LabelObservation[];
  postings: readonly PostingLink[];
  pins: readonly EmployerPin[];
  urlPins?: ReadonlyMap<string, string>;
  labelPins?: readonly EmployerLabelPin[];
  manualKeys?: ReadonlySet<string>;
  manualUrlKeys?: ReadonlySet<string>;
}): EmployerLearningPlan {
  const nodes = new Map<string, Node>();
  const labelPins = new Map((input.labelPins || []).map((pin) => [employerLabelKey(pin.label), pin.name]));
  const nodeFor = (company: string): Node | null => {
    const pinnedLabel = labelPins.has(employerLabelKey(company));
    const key = pinnedLabel ? `label:${employerLabelKey(company)}` : employerAliasKey(company);
    if (!key) return null;
    let node = nodes.get(key);
    if (!node) nodes.set(key, node = { key, labels: new Map(), urlKeys: new Set(), pin: null });
    return node;
  };
  for (const observation of input.labels) {
    const node = nodeFor(observation.company);
    if (!node) continue;
    const stats = node.labels.get(observation.company) || { rows: 0, aggregatorRows: 0, sources: new Set<string>() };
    stats.rows += observation.rows;
    if (!/^ATS-/i.test(observation.source || '')) stats.aggregatorRows += observation.rows;
    if (observation.source) stats.sources.add(observation.source);
    node.labels.set(observation.company, stats);
    for (const url of observation.urlKeys) node.urlKeys.add(url);
  }
  for (const node of nodes.values()) {
    if (node.key.startsWith('label:')) node.pin = labelPins.get(node.key.slice('label:'.length)) ?? null;
  }
  for (const pin of input.pins) {
    const node = nodes.get(pin.key);
    if (node && !node.pin) node.pin = pin.name;
  }
  for (const node of nodes.values()) {
    if (node.pin || !input.urlPins) continue;
    const pinned = [...node.urlKeys].map((url) => input.urlPins!.get(url)).find(Boolean);
    if (pinned) node.pin = pinned;
  }

  // Evidence between spellings with different alias keys.
  const edges = new Map<string, Edge>();
  const edgeFor = (left: Node, right: Node): Edge | null => {
    if (left.key === right.key) return null;
    const [a, b] = left.key < right.key ? [left, right] : [right, left];
    const id = `${a.key}|${b.key}`;
    let edge = edges.get(id);
    if (!edge) {
      edges.set(id, edge = { left: a.key, right: b.key, relation: employerNameRelation(bestLabel(a), bestLabel(b)), site: 0, postings: new Set() });
    }
    return edge;
  };
  const bySite = new Map<string, Node[]>();
  for (const node of nodes.values()) for (const url of node.urlKeys) {
    const list = bySite.get(url) || [];
    list.push(node);
    bySite.set(url, list);
  }
  for (const list of bySite.values()) {
    if (list.length < 2 || list.length > 12) continue;
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
      const edge = edgeFor(list[i], list[j]);
      if (edge) edge.site += 1;
    }
  }
  for (const link of input.postings) {
    if (link.containment < EMPLOYER_POSTING_CONTAINMENT) continue;
    const left = nodeFor(link.left);
    const right = nodeFor(link.right);
    if (!left || !right) continue;
    const edge = edgeFor(left, right);
    if (edge) edge.postings.add([...link.jobIds].sort().join('|'));
  }

  const refused: EmployerLearningPlan['refused'] = [];
  const accepted: Array<Edge & { relation: NameRelation }> = [];
  for (const edge of edges.values()) {
    const evidence = { site: edge.site, postings: edge.postings.size };
    const relation = edge.relation;
    const leftLabel = bestLabel(nodes.get(edge.left)!);
    const rightLabel = bestLabel(nodes.get(edge.right)!);
    if (!relation) {
      refused.push({ left: leftLabel, right: rightLabel, reason: 'names_unrelated', ...evidence });
      continue;
    }
    const enough = relation === 'short' ? edge.site >= 1 || edge.postings.size >= 2 : edge.site >= 1 || edge.postings.size >= 1;
    if (!enough) {
      if (edge.postings.size) refused.push({ left: leftLabel, right: rightLabel, reason: 'needs_more_evidence', ...evidence });
      continue;
    }
    accepted.push({ ...edge, relation });
  }
  accepted.sort((a, b) => RELATION_RANK[b.relation] - RELATION_RANK[a.relation]
    || (b.site + b.postings.size) - (a.site + a.postings.size));

  // Union with pins as walls between different names.
  const parent = new Map([...nodes.keys()].map((key) => [key, key]));
  const pinOf = new Map<string, string | null>([...nodes.values()].map((node) => [node.key, node.pin]));
  const root = (key: string): string => {
    let current = key;
    while (parent.get(current) !== current) current = parent.get(current)!;
    parent.set(key, current);
    return current;
  };
  const union = (a: string, b: string): boolean => {
    const [ra, rb] = [root(a), root(b)];
    if (ra === rb) return true;
    const [pa, pb] = [pinOf.get(ra), pinOf.get(rb)];
    if (pa && pb && pa !== pb) return false;
    parent.set(ra, rb);
    pinOf.set(rb, pb || pa || null);
    return true;
  };
  const byPin = new Map<string, string>();
  for (const node of nodes.values()) {
    if (!node.pin) continue;
    const first = byPin.get(node.pin);
    if (first) union(node.key, first); else byPin.set(node.pin, node.key);
  }
  for (const edge of accepted) {
    if (!union(edge.left, edge.right)) {
      refused.push({
        left: bestLabel(nodes.get(edge.left)!), right: bestLabel(nodes.get(edge.right)!),
        reason: 'pinned_apart', site: edge.site, postings: edge.postings.size,
      });
    }
  }

  const components = new Map<string, Node[]>();
  for (const node of nodes.values()) {
    const id = root(node.key);
    const list = components.get(id) || [];
    list.push(node);
    components.set(id, list);
  }

  const rules: LearnedEmployerRule[] = [];
  const groups: EmployerLearningPlan['groups'] = [];
  const nameByUrl = new Map<string, Set<string>>();
  const emit = (members: Node[], name: string, pinned: boolean) => {
    const labels = members.flatMap((node) => [...node.labels.keys()]);
    const presentable = new Set(labels.map((label) => presentableEmployerName(label)));
    for (const node of members) for (const url of node.urlKeys) {
      const names = nameByUrl.get(url) || new Set<string>();
      names.add(name);
      nameByUrl.set(url, names);
    }
    if (members.length < 2 && presentable.size < 2 && (presentable.has(name) || presentable.size === 0)) return;
    groups.push({ name, labels, pinned });
    const links = [...edges.values()].filter((edge) => members.some((node) => node.key === edge.left) && members.some((node) => node.key === edge.right));
    for (const node of members) {
      if (input.manualKeys?.has(node.key) || node.key.startsWith('label:')) continue;
      rules.push({
        matchType: EMPLOYER_NAME_RULE,
        matchKey: node.key,
        standardName: name,
        evidence: {
          labels: labels.slice(0, 20),
          pinned,
          links: links.filter((edge) => edge.left === node.key || edge.right === node.key).slice(0, 10)
            .map((edge) => ({ with: edge.left === node.key ? edge.right : edge.left, relation: edge.relation, site: edge.site, postings: edge.postings.size })),
        },
      });
    }
  };
  for (const members of components.values()) {
    const pinned = members.find((node) => node.pin)?.pin ?? null;
    const name = pinned || canonicalFor(members);
    // Every member must relate to the group's name itself.
    const kept = members.filter((node) => node.pin === name || [...node.labels.keys()].some((label) => employerNameRelation(label, name)));
    const detached = members.filter((node) => !kept.includes(node));
    for (const node of detached) {
      refused.push({ left: bestLabel(node), right: name, reason: 'not_related_to_group_name', site: 0, postings: 0 });
      emit([node], node.pin || canonicalFor([node]), Boolean(node.pin));
    }
    if (kept.length) emit(kept, name, Boolean(pinned));
  }
  // A site whose spellings all resolve to one employer names new spellings
  // from it too; a tenant shared by several employers (VF, Cigna) does not.
  const groupNames = new Set(groups.map((group) => group.name));
  for (const [url, names] of nameByUrl) {
    if (names.size !== 1 || input.manualUrlKeys?.has(url)) continue;
    const [name] = names;
    if (!groupNames.has(name)) continue;
    rules.push({ matchType: COMPANY_EMPLOYER_URL_RULE, matchKey: url, standardName: name, evidence: { site: true } });
  }
  return { rules, groups, refused };
}

// ---------------------------------------------------------------------------
// Loading

type LearningStore = Pick<PrismaClient, 'job' | 'companyNameRule' | '$queryRaw' | '$transaction'>;

export async function loadLabelObservations(store: LearningStore): Promise<{
  labels: LabelObservation[];
  rows: Array<{ id: string; company: string; title: string; location: string | null; source: string | null }>;
}> {
  const rows = await store.job.findMany({
    where: EMPLOYER_CARD_WHERE,
    select: { id: true, company: true, title: true, location: true, source: true, url: true, canonicalUrl: true },
  });
  const grouped = new Map<string, LabelObservation & { urlKeys: string[] }>();
  for (const row of rows) {
    const urlKeys = [...new Set([row.canonicalUrl, row.url].map(employerUrlKey).filter((key): key is string => Boolean(key)))];
    const id = `${row.company}\u0000${row.source}\u0000${urlKeys.join(',')}`;
    const current = grouped.get(id);
    if (current) current.rows += 1;
    else grouped.set(id, { company: row.company, source: row.source, urlKeys, rows: 1 });
  }
  return { labels: [...grouped.values()], rows };
}

/**
 * Pairs of postings that are the same job under differently keyed spellings
 * whose names relate. Descriptions are read only for those candidates.
 */
export async function loadPostingLinks(
  store: LearningStore,
  rows: ReadonlyArray<{ id: string; company: string; title: string; location: string | null; source: string | null }>,
): Promise<PostingLink[]> {
  const byTitle = new Map<string, typeof rows[number][]>();
  for (const row of rows) {
    const key = sameJobTitleKey(row.title);
    if (!key) continue;
    const list = byTitle.get(key) || [];
    list.push(row);
    byTitle.set(key, list);
  }
  const candidatePairs: Array<[typeof rows[number], typeof rows[number]]> = [];
  for (const list of byTitle.values()) {
    if (list.length < 2 || list.length > 60) continue;
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
      const [a, b] = [list[i], list[j]];
      if (employerAliasKey(a.company) === employerAliasKey(b.company)) continue;
      if (!employerNameRelation(a.company, b.company)) continue;
      candidatePairs.push([a, b]);
    }
  }
  if (candidatePairs.length === 0) return [];
  const ids = [...new Set(candidatePairs.flat().map((row) => row.id))];
  const descriptions = new Map<string, string | null>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = await store.job.findMany({ where: { id: { in: ids.slice(offset, offset + 500) } }, select: { id: true, description: true } });
    for (const row of chunk) descriptions.set(row.id, row.description);
  }
  const cache = new Map<string, Set<string>>();
  const subject = (row: typeof rows[number]): SameJobSubject => ({ ...row, description: descriptions.get(row.id) ?? null });
  const links: PostingLink[] = [];
  for (const [a, b] of candidatePairs) {
    const evidence = judgeSameJob(subject(a), subject(b), cache);
    if (evidence?.rule !== 'description' || (evidence.containment ?? 0) < EMPLOYER_POSTING_CONTAINMENT) continue;
    links.push({ left: a.company, right: b.company, jobIds: [a.id, b.id], containment: evidence.containment! });
  }
  return links;
}

async function loadPins(store: LearningStore): Promise<{
  pins: EmployerPin[]; labelPins: EmployerLabelPin[]; urlPins: Map<string, string>; manualKeys: Set<string>; manualUrlKeys: Set<string>;
}> {
  const manual = await store.companyNameRule.findMany({
    where: { origin: { not: LEARNED_RULE_ORIGIN } },
    select: { matchType: true, matchKey: true, standardName: true },
  });
  const pins: EmployerPin[] = [];
  const labelPins: EmployerLabelPin[] = [];
  const urlPins = new Map<string, string>();
  const manualKeys = new Set<string>();
  const manualUrlKeys = new Set<string>();
  for (const rule of manual) {
    if (rule.matchType === COMPANY_EMPLOYER_URL_RULE) {
      urlPins.set(rule.matchKey, rule.standardName);
      manualUrlKeys.add(rule.matchKey);
      continue;
    }
    if (rule.matchType === EMPLOYER_LABEL_RULE) {
      labelPins.push({ label: rule.matchKey, name: rule.standardName });
      continue;
    }
    const key = employerAliasKey(rule.matchKey);
    if (!key) continue;
    pins.push({ key, name: rule.standardName });
    if (rule.matchType === EMPLOYER_NAME_RULE) manualKeys.add(key);
  }
  for (const group of REVIEWED_EMPLOYER_GROUPS) {
    for (const alias of [group.name, ...group.aliases]) {
      const key = employerAliasKey(alias);
      if (key) pins.push({ key, name: group.name });
    }
  }
  for (const [url, name] of REVIEWED_EMPLOYER_URL_NAMES) if (!urlPins.has(url)) urlPins.set(url, name);
  return { pins, labelPins, urlPins, manualKeys, manualUrlKeys };
}

export async function learnEmployerRules(
  options: { apply?: boolean; client?: LearningStore } = {},
): Promise<EmployerLearningPlan & { applied: boolean }> {
  const store = options.client || prisma;
  const { labels, rows } = await loadLabelObservations(store);
  const [postings, pins] = await Promise.all([loadPostingLinks(store, rows), loadPins(store)]);
  const plan = planEmployerLearning({ labels, postings, ...pins });
  if (!options.apply) return { ...plan, applied: false };
  // The learned set is replaced as a whole, but only rows that changed are
  // written. Joseph's rows are never touched: a learned rule never takes a
  // key he owns (skipDuplicates keeps his row if one appears meanwhile).
  await store.$transaction(async (tx) => {
    const existing = await tx.companyNameRule.findMany({
      where: { origin: LEARNED_RULE_ORIGIN },
      select: { matchType: true, matchKey: true, standardName: true },
    });
    const id = (rule: { matchType: string; matchKey: string }) => `${rule.matchType}\u0000${rule.matchKey}`;
    const wanted = new Map(plan.rules.map((rule) => [id(rule), rule]));
    const stale = existing.filter((rule) => wanted.get(id(rule))?.standardName !== rule.standardName);
    for (let offset = 0; offset < stale.length; offset += 500) {
      await tx.companyNameRule.deleteMany({ where: { origin: LEARNED_RULE_ORIGIN, OR: stale.slice(offset, offset + 500).map(({ matchType, matchKey }) => ({ matchType, matchKey })) } });
    }
    const kept = new Set(existing.filter((rule) => !stale.includes(rule)).map(id));
    const fresh = plan.rules.filter((rule) => !kept.has(id(rule)));
    for (let offset = 0; offset < fresh.length; offset += 500) {
      await tx.companyNameRule.createMany({
        data: fresh.slice(offset, offset + 500).map((rule) => ({ ...rule, origin: LEARNED_RULE_ORIGIN })),
        skipDuplicates: true,
      });
    }
  }, { timeout: 60_000 });
  await loadEmployerRuleIndex(store, { fresh: true });
  return { ...plan, applied: true };
}

// ---------------------------------------------------------------------------
// Keeping cards current

export type EmployerAssignment = { id: string; company: string; from: string | null; to: string };

/**
 * Resolves the employer of every card that matters, and of every card created
 * in the last two weeks, and writes the ones that changed. `company` is only
 * read.
 */
export async function assignEmployers(
  options: { apply?: boolean; client?: Pick<PrismaClient, 'job' | 'companyNameRule'>; now?: Date } = {},
): Promise<{ checked: number; changed: EmployerAssignment[] }> {
  const store = options.client || prisma;
  const index = await loadEmployerRuleIndex(store, { fresh: true });
  const since = new Date((options.now || new Date()).valueOf() - 14 * 24 * 60 * 60 * 1000);
  const rows = await store.job.findMany({
    where: { OR: [EMPLOYER_CARD_WHERE, { createdAt: { gte: since } }] },
    select: { id: true, company: true, url: true, canonicalUrl: true, source: true, employer: true },
  });
  const changed: EmployerAssignment[] = [];
  for (const row of rows) {
    const to = resolveEmployer(row, index);
    if (to && to !== row.employer) changed.push({ id: row.id, company: row.company, from: row.employer, to });
  }
  if (options.apply && changed.length) {
    const byName = new Map<string, string[]>();
    for (const change of changed) byName.set(change.to, [...(byName.get(change.to) || []), change.id]);
    for (const [employer, ids] of byName) {
      for (let offset = 0; offset < ids.length; offset += 1000) {
        await store.job.updateMany({ where: { id: { in: ids.slice(offset, offset + 1000) } }, data: { employer } });
      }
    }
  }
  return { checked: rows.length, changed };
}

/** Learn, then bring every card's employer up to date. */
export async function refreshEmployers(options: { learn?: boolean } = {}): Promise<{ learnedRules: number | null; changed: number }> {
  const learned = options.learn === false ? null : await learnEmployerRules({ apply: true });
  const assigned = await assignEmployers({ apply: true });
  return { learnedRules: learned ? learned.rules.length : null, changed: assigned.changed.length };
}
