# secrets/

Nothing in this directory is committed except this file.

- `backup_encryption_key` - passphrase for the encrypted backups
  (`make backup`). Create it private from the start, then give it to the backup service's user (uid 1000), as docs/INSTALL.md section 6 does: `(umask 077; openssl rand -base64 48 > secrets/backup_encryption_key) && sudo chown 1000:1000 secrets/backup_encryption_key`.

Burrow's own master key (`BURROW_SECRET`) is not stored here: it is generated
in the data volume on first start (`secret.key`, mode 0600) unless you set
`BURROW_SECRET` yourself. Back it up - without it the stored SSH keys and
passwords cannot be decrypted.
