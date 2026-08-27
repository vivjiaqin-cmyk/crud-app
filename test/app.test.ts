import { describe, expect, it } from 'vitest';
import { fixtures, request, requestWith } from './helpers';

describe('cross-cutting behaviour', () => {
  it('reports healthy with a working database', async () => {
    const { status, body } = await request('/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.database).toMatchObject({ ok: true, items: 0 });
  });

  it('lists its own endpoints at /api', async () => {
    const { status, body } = await request('/api');
    expect(status).toBe(200);
    expect(body.name).toBe('crud-app');
    expect(body.endpoints).toContain('POST   /movements');
  });

  it('names the method and path it could not route', async () => {
    const { status, body } = await request('/nope');
    expect(status).toBe(404);
    expect(body.error).toBe('No handler for GET /nope');
  });

  it('rejects a malformed JSON body as a client error', async () => {
    const { status, body } = await request('/items', { method: 'POST', raw: '{nope}' });
    expect(status).toBe(400);
    expect(body.error).toBe('Request body is not valid JSON');
  });

  it('rejects an empty body on a write', async () => {
    const { status } = await request('/items', { method: 'POST', raw: '' });
    expect(status).toBe(400);
  });

  // Regression: an oversized body used to be read in full and then rejected by a
  // field-length check, reporting a 400 about one field rather than the size.
  it('refuses an oversized body with 413 before parsing it', async () => {
    const { status, body } = await request('/items', {
      method: 'POST',
      body: { sku: 'BIG', name: 'big', description: 'x'.repeat(100 * 1024) },
    });
    expect(status).toBe(413);
    expect(body.error).toMatch(/too large/i);
  });

  it('accepts a body just under the limit', async () => {
    await fixtures();
    const { status } = await request('/items', {
      method: 'POST',
      body: { sku: 'JUST-UNDER', name: 'x'.repeat(200) },
    });
    expect(status).toBe(201);
  });
});

describe('CORS', () => {
  const preflight = { method: 'OPTIONS', headers: { origin: 'https://evil.example' } };

  // The API has no authentication, so a permissive default is what would let any
  // page the operator visits write to their ledger.
  it('sends no Access-Control-Allow-Origin by default', async () => {
    const { headers } = await requestWith({ CORS_ORIGINS: '' }, '/items', {
      headers: { origin: 'https://evil.example' },
    });
    expect(headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not approve a cross-origin preflight by default', async () => {
    const { headers } = await requestWith({ CORS_ORIGINS: '' }, '/items', preflight);
    expect(headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows any origin when explicitly set to *', async () => {
    const { headers } = await requestWith({ CORS_ORIGINS: '*' }, '/items', {
      headers: { origin: 'https://evil.example' },
    });
    expect(headers.get('access-control-allow-origin')).toBe('*');
  });

  it('echoes only listed origins, and varies on Origin', async () => {
    const allowed = await requestWith(
      { CORS_ORIGINS: 'https://ops.example, https://admin.example' },
      '/items',
      { headers: { origin: 'https://ops.example' } },
    );
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://ops.example');
    expect(allowed.headers.get('vary')).toMatch(/origin/i);

    const refused = await requestWith(
      { CORS_ORIGINS: 'https://ops.example, https://admin.example' },
      '/items',
      { headers: { origin: 'https://evil.example' } },
    );
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers an approved preflight with the methods a client needs', async () => {
    const { status, headers } = await requestWith({ CORS_ORIGINS: '*' }, '/items', preflight);
    expect(status).toBe(204);
    expect(headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(headers.get('access-control-allow-methods')).toContain('DELETE');
  });
});
