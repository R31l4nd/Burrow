import { RE2JS } from 're2js';

// Regular expressions from people (alert rules, image tag labels) run
// against text from elsewhere (log lines): with RE2 their time grows with
// the text, never exponentially. "(a+)+$" against a line of a's held up the
// whole server. RE2 has no look-around or back-references.

/** A case-insensitive matcher, or an Error saying why the pattern cannot be one. */
export function linearMatcher(pattern: string): ((text: string) => boolean) | Error {
  try {
    const re = RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
    return (text) => re.matcher(text).find();
  } catch (err) {
    return new Error((err as Error).message);
  }
}
