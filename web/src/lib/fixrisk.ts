import { assessCommand, maxRisk, type ReportFix, type Risk } from '@burrow/shared';

/**
 * A fix's command and how risky it is to run: the model's label counts for its own command only,
 * and never below Burrow's rules; an edited command is judged by the rules alone. When the rules
 * raised the label, their reasons are said too, beside the model's: a fix from an analysis came
 * with none, and showed "High" without a word why (audit 2026-11-05).
 */
export function judgeFix(fix: Pick<ReportFix, 'command' | 'risk' | 'riskReasons'> | null, command: string): { risk: Risk; reasons: string[] } {
  const rules = assessCommand(command);
  if (!fix || command.trim() !== (fix.command ?? '').trim()) return rules;
  return { risk: maxRisk(fix.risk, rules.risk), reasons: [...new Set([...fix.riskReasons, ...rules.reasons])] };
}
