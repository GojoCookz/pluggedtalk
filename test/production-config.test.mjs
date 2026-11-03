import { test, expect } from 'bun:test';
import { assertProductionConfig, assertSameOrigin } from '../lib/http-api.mjs';

test('L5: production refuses to start without an exact https PLUGGED_PUBLIC_ORIGIN', () => {
  for (const origin of [undefined, '', 'http://plugged.example', 'https://plugged.example/app', 'not a url'])
    expect(() => assertProductionConfig({ NODE_ENV: 'production', PLUGGED_PUBLIC_ORIGIN: origin })).toThrow('PLUGGED_PUBLIC_ORIGIN');
  expect(() => assertProductionConfig({ NODE_ENV: 'production', PLUGGED_PUBLIC_ORIGIN: 'https://plugged.example' })).not.toThrow();
  expect(() => assertProductionConfig({ NODE_ENV: 'development' })).not.toThrow();
});

test('L5: production requests never fall back to the Host header comparison', () => {
  const req = { headers: { origin: 'https://attacker.example', host: 'attacker.example' } };
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    expect(() => assertSameOrigin(req, '')).toThrow('not configured');
    expect(() => assertSameOrigin(req, 'https://plugged.example')).toThrow('same-origin');
    expect(() => assertSameOrigin({ headers: { origin: 'https://plugged.example' } }, 'https://plugged.example')).not.toThrow();
  } finally { process.env.NODE_ENV = previous; }
  expect(() => assertSameOrigin(req, '')).not.toThrow();
});
