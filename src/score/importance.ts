// Technical importance: derived only from what a PR changes and how it is described,
// never from comment counts or other popularity signals.
//
//   raw   = best subsystem score + min(secondaryWeight × other subsystem scores, cap) + signals
//   raw  ×= backportMultiplier            (if the PR targets a release branch)
//   raw  ×= mechanicalMultiplier          (if the title describes a move/rename/cleanup)
//   score = 100 × (1 − e^(−raw / scale))  (0–100, saturating)

import type { ClassificationRules, ImportanceConfig } from '../config.ts';
import type { ChangedFile, Evidence, PrRecord, TechnicalResult } from '../types.ts';
import { globToRegExp, matchesAny } from '../util/glob.ts';
import { stripTemplate } from '../util/text.ts';
import { round } from '../util/time.ts';
import { churn, classify, fileKind } from './classify.ts';

const FORMAT_WEIGHT = 10;
const DESIGN_DOC_WEIGHT = 4;

export function technicalImportance(rec: PrRecord, rules: ClassificationRules, cfg: ImportanceConfig): TechnicalResult {
  const backport = !cfg.mainBranches.includes(rec.baseRef);
  const mechanical = new RegExp(rules.mechanicalTitlePattern, 'i').test(rec.title);
  const flags = { backport, mechanical, testOnly: false, docsOnly: false, filesTruncated: rec.filesTruncated };
  const body = stripTemplate(rec.body);

  if (rec.detail !== 'full' || rec.files.length === 0) {
    return {
      score: 0, raw: 0, important: false, confidence: null, subsystems: [], signals: [],
      explanation: 'Changed files not collected yet; cannot classify.', relevantFiles: [], coreLines: 0, flags,
    };
  }

  const kinds = rec.files.map((f) => fileKind(f.path, rules));
  flags.testOnly = kinds.every((k) => k === 'test');
  flags.docsOnly = !flags.testOnly && kinds.every((k) => k === 'test' || k === 'docs');

  const { matches, coreFiles } = classify(rec, rules, cfg);
  const coreLines = coreFiles.reduce((n, f) => n + churn(f), 0);

  // Cross-cutting signals. Text signals only count when core code actually changes,
  // so a description alone never makes a PR "important".
  const signals: Evidence[] = [];
  const formatFiles = coreFiles.filter((f) => matchesAny(f.path, rules.formatPaths));
  if (formatFiles.length) {
    signals.push({ type: 'format', detail: 'touches persistent or wire-format definitions (encode/decode, on-disk types)', weight: FORMAT_WEIGHT, files: formatFiles.map((f) => f.path).slice(0, 5) });
  }
  const designDocs = rec.files.filter((f) => matchesAny(f.path, rules.designDocPaths));
  if (designDocs.length && coreFiles.length) {
    signals.push({ type: 'design-doc', detail: 'includes developer/design documentation', weight: DESIGN_DOC_WEIGHT, files: designDocs.map((f) => f.path).slice(0, 3) });
  }
  if (coreFiles.length) {
    for (const s of rules.signals) {
      const re = new RegExp(s.pattern, 'i');
      const t = re.exec(rec.title);
      const b = t ? null : re.exec(body);
      if (t || b) signals.push({ type: 'signal', detail: `${s.description}: ${t ? 'title' : 'description'} says "${(t ?? b)![0]}"`, weight: t ? s.weight : s.weight / 2 });
    }
  }

  const subScores = matches.map((m) => m.score);
  const best = subScores[0] ?? 0;
  const others = subScores.slice(1).reduce((a, b) => a + b, 0);
  // Incidental small touches of other subsystems add a little, but cannot pile up.
  const secondary = Math.min(cfg.secondarySubsystemWeight * others, cfg.secondarySubsystemCap);
  let raw = best + secondary + (matches.length ? signals.reduce((a, s) => a + s.weight, 0) : 0);
  if (backport) raw *= cfg.backportMultiplier;
  if (mechanical) raw *= cfg.mechanicalMultiplier;
  if (flags.testOnly || flags.docsOnly || coreFiles.length === 0) raw = 0;
  const score = Math.round(100 * (1 - Math.exp(-raw / cfg.scale)));
  const important = score >= cfg.minScore && matches.length > 0;

  // Files backing the classification, largest change first.
  const relevant = new Set<string>(formatFiles.map((f) => f.path));
  for (const m of matches) for (const e of m.evidence) for (const p of e.files ?? []) relevant.add(p);
  for (const f of coreFiles) {
    if (rules.subsystems.some((s) => s.paths.some((r) => globToRegExp(r.pattern).test(f.path)))) relevant.add(f.path);
  }
  const relevantFiles: ChangedFile[] = coreFiles.filter((f) => relevant.has(f.path)).sort((a, b) => churn(b) - churn(a)).slice(0, cfg.maxRelevantFiles);

  return {
    score,
    raw: round(raw),
    important,
    confidence: matches[0]?.confidence ?? null,
    subsystems: matches,
    signals,
    explanation: explain(matches, signals, rules, flags, coreFiles.length),
    relevantFiles,
    coreLines,
    flags,
  };
}

function explain(matches: TechnicalResult['subsystems'], signals: Evidence[], rules: ClassificationRules, flags: TechnicalResult['flags'], coreCount: number): string {
  if (flags.testOnly) return 'Only test/QA files changed.';
  if (flags.docsOnly) return 'Only documentation (and tests) changed.';
  if (!coreCount) return 'No core source files changed.';
  if (!matches.length) return 'Changes do not match any tracked subsystem rules.';
  const parts: string[] = [];
  for (const m of matches.slice(0, 2)) {
    const name = rules.subsystems.find((s) => s.id === m.id)?.name ?? m.id;
    const top = m.evidence.find((e) => e.type === 'path' || e.type === 'breadth') ?? m.evidence[0];
    parts.push(`${name}: ${top.detail}`);
  }
  for (const s of signals.filter((s) => s.type === 'format' || s.type === 'design-doc').slice(0, 1)) parts.push(s.detail);
  const textSignal = signals.find((s) => s.type === 'signal');
  if (textSignal) parts.push(textSignal.detail);
  if (flags.backport) parts.push('backport to a release branch (weighted down)');
  if (flags.mechanical) parts.push('title describes a move/rename/cleanup (weighted down)');
  return parts.join('; ') + '.';
}
