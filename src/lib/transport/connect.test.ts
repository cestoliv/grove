import { describe, expect, it } from 'vitest';
import { connect } from './connect.js';
import { LocalTransport } from './local.js';
import { SshTransport } from './ssh.js';

describe('connect', () => {
  it('returns a local transport for a local host', () => {
    const transport = connect('mac', { type: 'local' });
    expect(transport).toBeInstanceOf(LocalTransport);
    expect(transport.name).toBe('mac');
  });

  it('returns an ssh transport for an ssh host', () => {
    const transport = connect('atlas', { type: 'ssh', host: 'atlas' });
    expect(transport).toBeInstanceOf(SshTransport);
    expect(transport.name).toBe('atlas');
  });

  it('addresses the ssh transport by the configured host string', () => {
    const transport = connect('atlas', {
      type: 'ssh',
      host: 'ci@atlas.internal',
    }) as SshTransport;
    expect(transport.argsFor('true', []).at(-2)).toBe('ci@atlas.internal');
  });

  it('passes the ssh overrides through', () => {
    const transport = connect(
      'atlas',
      { type: 'ssh', host: 'atlas' },
      { ssh: { controlPersist: '5m', connectTimeoutSeconds: 3 } },
    ) as SshTransport;
    const args = transport.argsFor('true', []);
    expect(args).toContain('ControlPersist=5m');
    expect(args).toContain('ConnectTimeout=3');
  });
});
