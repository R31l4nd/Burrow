// What press-all.spec.ts presses, and what it never presses blindly: what
// removes, ends, deploys or leaves Burrow.

export const SELECTOR = 'button, [role=button], a[href], [role=tab], [role=option], input[type=checkbox], input[type=radio], select, summary';

export const SKIP = [
  /delete|remove|withdraw|revoke|unpair|forget|uninstall|clear|reset|discard/i,
  /sign out|log ?out|close session|end session|step up|fingerprint/i,
  /restart|^stacks:button:(up|down|pull)$|deploy|run\b|adhoc-run/i,
  /^[a-z-]+:a:(chatgpt|claude|all releases|open in a new tab)/i,
];
