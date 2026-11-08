/**
 * The label of "what is new" over several updates: the number with notes,
 * and of how many updates when some have none (report 2fe705: "17 updates"
 * beside 18 read as a miscount).
 */
export function notesLabel(n: number, total: number): { key: 'changelog.openAll' | 'changelog.openSome'; n: number; total: number } {
  return { key: n < total ? 'changelog.openSome' : 'changelog.openAll', n, total };
}
