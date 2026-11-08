-- An OpenID Connect subject is unique only at its own provider: links keep
-- the issuer beside it. Existing links were made with the provider set now.
ALTER TABLE users ADD COLUMN oidc_iss TEXT;
UPDATE users SET oidc_iss = (SELECT rtrim(json_extract(value, '$.issuer'), '/') FROM app_settings WHERE key = 'oidc') WHERE oidc_sub IS NOT NULL;
