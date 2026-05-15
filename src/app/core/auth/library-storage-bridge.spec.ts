import { TestBed } from '@angular/core/testing';
import { LibraryStorageBridge } from './library-storage-bridge';
import { APP_CONFIG } from '../config/app-config';

const KEY = `0-${APP_CONFIG.cognito.clientId}`;

function setup() {
  TestBed.configureTestingModule({ providers: [LibraryStorageBridge] });
  return { bridge: TestBed.inject(LibraryStorageBridge) };
}

describe('LibraryStorageBridge', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
  });

  it('read returns {} when storage is empty', () => {
    const { bridge } = setup();
    expect(bridge.read()).toEqual({});
  });

  it('read returns the parsed blob when present', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ authnResult: { access_token: 'at' }, foo: 'bar' })
    );
    const { bridge } = setup();
    expect(bridge.read()).toEqual({
      authnResult: { access_token: 'at' },
      foo: 'bar',
    });
  });

  it('readRefreshToken extracts refresh_token from authnResult', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ authnResult: { refresh_token: 'rt-xyz' } })
    );
    const { bridge } = setup();
    expect(bridge.readRefreshToken()).toBe('rt-xyz');
  });

  it('readRefreshToken returns null when missing', () => {
    const { bridge } = setup();
    expect(bridge.readRefreshToken()).toBeNull();
  });

  it('applyTokenResponse writes new tokens, preserves other state', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        authnResult: { refresh_token: 'old-rt', access_token: 'old-at' },
        authWellKnownEndPoints: { issuer: 'https://example' },
        authStateControl: 'abc',
      })
    );
    const { bridge } = setup();
    bridge.applyTokenResponse({
      access_token: 'new-at',
      id_token: 'new-id',
      refresh_token: 'new-rt',
      token_type: 'Bearer',
      expires_in: 86400,
    });
    const blob = JSON.parse(localStorage.getItem(KEY)!);
    expect(blob.authnResult.access_token).toBe('new-at');
    expect(blob.authnResult.id_token).toBe('new-id');
    expect(blob.authnResult.refresh_token).toBe('new-rt');
    expect(blob.authzData).toBe('new-at');
    expect(blob.authWellKnownEndPoints).toEqual({
      issuer: 'https://example',
    });
    expect(blob.authStateControl).toBe('abc');
  });

  it('applyTokenResponse falls back to previous refresh_token when response omits it', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ authnResult: { refresh_token: 'keep-me' } })
    );
    const { bridge } = setup();
    bridge.applyTokenResponse({
      access_token: 'at',
      id_token: 'id',
      token_type: 'Bearer',
      expires_in: 86400,
    });
    const blob = JSON.parse(localStorage.getItem(KEY)!);
    expect(blob.authnResult.refresh_token).toBe('keep-me');
  });

  it('applyTokenResponse seeds an empty blob when nothing was stored', () => {
    const { bridge } = setup();
    bridge.applyTokenResponse({
      access_token: 'at',
      id_token: 'id',
      refresh_token: 'rt',
      token_type: 'Bearer',
      expires_in: 86400,
    });
    const blob = JSON.parse(localStorage.getItem(KEY)!);
    expect(blob.authnResult).toEqual({
      access_token: 'at',
      id_token: 'id',
      refresh_token: 'rt',
      token_type: 'Bearer',
      expires_in: 86400,
    });
    expect(blob.authzData).toBe('at');
  });
});
