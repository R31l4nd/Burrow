# 3. Trust on first use for host keys

Date: 2026-09-26 - Status: accepted

## Decision

The first connection to host:port stops and shows the key fingerprint. The
user confirms; Burrow then fetches the key again and stores it only if the
fingerprint still matches what was shown. Any other key afterwards -
including one of a different type - blocks the connection until an admin
deletes the stored entry (step-up required).

## Consequences

No silent acceptance, ever. A reinstalled host needs one deliberate action.
The same store is shared with the Android direct route later, so both paths
agree on what is trusted.
