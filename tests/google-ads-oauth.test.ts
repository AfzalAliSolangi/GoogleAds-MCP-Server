import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Google Ads OAuth refresh token', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exchanges refresh token and caches access token until near expiry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getAdsAccessToken } = await import('../shared/google-ads-client.js');

    const env = {
      GOOGLE_ADS_OAUTH_CLIENT_ID: 'cid',
      GOOGLE_ADS_OAUTH_CLIENT_SECRET: 'csec',
      GOOGLE_ADS_REFRESH_TOKEN: 'rt',
    };

    const t1 = await getAdsAccessToken(env);
    const t2 = await getAdsAccessToken(env);

    expect(t1).toBe('at-1');
    expect(t2).toBe('at-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toContain('grant_type=refresh_token');
    expect(String(init?.body)).toContain('refresh_token=rt');
  });

  it('throws when only part of OAuth trio is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    );
    const { getAdsAccessToken } = await import('../shared/google-ads-client.js');

    await expect(
      getAdsAccessToken({
        GOOGLE_ADS_OAUTH_CLIENT_ID: 'x',
        GOOGLE_ADS_REFRESH_TOKEN: 'y',
      } as Record<string, string>),
    ).rejects.toThrow(/Incomplete Google Ads OAuth env/);
  });
});
