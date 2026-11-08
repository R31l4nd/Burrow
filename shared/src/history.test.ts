import { describe, expect, it } from 'vitest';
import { skipReason } from './history.js';

describe('commands the history does not keep', () => {
  it('a secret in JSON, after an escaped quote, or in curl -u written together (AUDIT2 AI-04)', () => {
    for (const c of [
      `curl -X POST -d '{"password":"hunter2"}' https://api.lan/login`,
      `curl -d "{\\"token\\":\\"abc123\\"}" https://api.lan`,
      'curl -uadmin:hunter2 https://nas.lan/api',
      'curl --user=admin:hunter2 https://nas.lan/api',
      'wget --http-password=hunter2 https://nas.lan/file',
    ])
      expect(skipReason(c), c).toBe('secret');
    // Ordinary commands stay.
    for (const c of ['curl -u https://example.com', 'docker compose up -d', 'passwd', 'grep -r token src/', 'curl -s https://nas.lan/api | jq .user'])
      expect(skipReason(c), c).toBeNull();
  });
});
