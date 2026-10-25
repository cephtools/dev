// Subsystem classification from changed paths (primary evidence), labels and
// title/description keywords (secondary evidence). A PR can match several subsystems.

import type { ClassificationRules, ImportanceConfig, SubsystemRule } from '../config.ts';
import type { ChangedFile, Confidence, Evidence, PrRecord, SubsystemMatch } from '../types.ts';
import { globToRegExp, matchesAny } from '../util/glob.ts';
import { stripTemplate } from '../util/text.ts';
import { round } from '../util/time.ts';

export type FileKind = 'test' | 'docs' | 'frontend' | 'core';

export function fileKind(path: string, rules: ClassificationRules): FileKind {
  if (matchesAny(path, rules.excludePaths.tests)) return 'test';
  if (matchesAny(path, rules.excludePaths.docs)) return 'docs';
  if (matchesAny(path, rules.excludePaths.frontend)) return 'frontend';
  return 'core';
}

export const churn = (f: ChangedFile) => f.additions + f.deletions;

/**
 * Weight multiplier for how much of a rule's code changed: a one-line touch counts
 * for less than a substantial rewrite, but the factor saturates so sheer size cannot
 * dominate. floor at 0 lines, +perDecade for every 10× lines, capped at 1.
 */
export function churnFactor(lines: number, cfg: ImportanceConfig['churn']): number {
  return Math.min(1, cfg.floor + cfg.perDecade * Math.log10(1 + lines));
}

function firstMatch(text: string, pattern: string): string | null {
  const m = new RegExp(pattern, 'i').exec(text);
  return m ? m[0] : null;
}

/** Distinct core areas touched with at least `minLinesPerArea` changed lines. */
export function touchedAreas(coreFiles: ChangedFile[], rules: ClassificationRules): string[] {
  const lines = new Map<string, number>();
  for (const f of coreFiles) {
    const area = rules.coreAreas.prefixes.find((p) => f.path.startsWith(p));
    if (area) lines.set(area, (lines.get(area) ?? 0) + churn(f));
  }
  return [...lines].filter(([, n]) => n >= rules.coreAreas.minLinesPerArea).map(([a]) => a.replace(/\/$/, ''));
}

function classifyOne(rec: PrRecord, sub: SubsystemRule, coreFiles: ChangedFile[], areas: string[], rules: ClassificationRules, cfg: ImportanceConfig): SubsystemMatch | null {
  const evidence: Evidence[] = [];

  // Path evidence: each file is attributed to the first (most specific) rule it matches.
  const groups = new Map<number, ChangedFile[]>();
  for (const f of coreFiles) {
    const idx = sub.paths.findIndex((r) => globToRegExp(r.pattern).test(f.path));
    if (idx >= 0) groups.set(idx, [...(groups.get(idx) ?? []), f]);
  }
  let pathScore = 0;
  for (const [idx, files] of groups) {
    const rule = sub.paths[idx];
    const lines = files.reduce((n, f) => n + churn(f), 0);
    const weight = rule.weight * churnFactor(lines, cfg.churn);
    pathScore += weight;
    files.sort((a, b) => churn(b) - churn(a));
    evidence.push({ type: 'path', detail: `${rule.note} (${files.length} file${files.length > 1 ? 's' : ''}, ${lines} lines)`, weight: round(weight), files: files.slice(0, 5).map((f) => f.path) });
  }
  if (sub.id === 'architecture' && areas.length >= rules.coreAreas.breadthThreshold) {
    // Capped: a tree-wide mechanical change touches many areas without being more significant.
    const weight = Math.min(rules.coreAreas.breadthWeightPerArea * areas.length, rules.coreAreas.breadthMax);
    pathScore += weight;
    evidence.push({ type: 'breadth', detail: `substantial changes across ${areas.length} core areas: ${areas.join(', ')}`, weight });
  }

  let keywordScore = 0;
  for (const k of sub.keywords) {
    const inTitle = firstMatch(rec.title, k.pattern);
    const inBody = inTitle ? null : firstMatch(rec.body, k.pattern);
    if (!inTitle && !inBody) continue;
    const weight = inTitle ? k.weight : k.weight / 2;
    keywordScore += weight;
    evidence.push({ type: 'keyword', detail: `${inTitle ? 'title' : 'description'} mentions "${inTitle ?? inBody}"`, weight });
  }
  keywordScore = Math.min(keywordScore, cfg.keywordCap);

  let labelScore = 0;
  const labels = rec.labels.map((l) => l.toLowerCase());
  for (const l of sub.labels) {
    if (labels.includes(l.name.toLowerCase())) {
      labelScore += l.weight;
      evidence.push({ type: 'label', detail: `label "${l.name}"`, weight: l.weight });
    }
  }
  labelScore = Math.min(labelScore, cfg.labelCap);

  if (sub.requirePathEvidence && pathScore === 0) return null;
  const textScore = keywordScore + labelScore;
  const score = pathScore + textScore;
  if (score < cfg.assignThreshold) return null;

  let confidence: Confidence;
  if (pathScore >= cfg.assignThreshold) confidence = textScore > 0 ? 'high' : 'medium';
  else if (pathScore > 0) confidence = 'medium';
  else confidence = 'low';

  evidence.sort((a, b) => b.weight - a.weight);
  return { id: sub.id, score: round(score), confidence, evidence };
}

export function classify(input: PrRecord, rules: ClassificationRules, cfg: ImportanceConfig): { matches: SubsystemMatch[]; coreFiles: ChangedFile[]; areas: string[] } {
  const rec = { ...input, body: stripTemplate(input.body) };
  const coreFiles = rec.files.filter((f) => fileKind(f.path, rules) === 'core');
  const areas = touchedAreas(coreFiles, rules);
  const matches = rules.subsystems
    .map((sub) => classifyOne(rec, sub, coreFiles, areas, rules, cfg))
    .filter((m): m is SubsystemMatch => m !== null)
    .sort((a, b) => b.score - a.score);
  return { matches, coreFiles, areas };
}
