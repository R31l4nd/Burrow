-- An OpenID Connect subject is unique at its own provider only (AUDIT2
-- AUTH-05): the same subject from another issuer is another person, and its
-- link failed on this index. Links kept from before stay as they are.
DROP INDEX users_oidc_sub;
CREATE UNIQUE INDEX users_oidc_identity ON users (oidc_iss, oidc_sub) WHERE oidc_sub IS NOT NULL;
