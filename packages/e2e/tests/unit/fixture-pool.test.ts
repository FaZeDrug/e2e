/** One fixture pool: a chain's test fixtures per attempt, its worker fixtures per worker, and what each scope sees. */

import { describe, expect, it, vi } from 'vitest';
import type { FixtureDefinition } from '../../src/collect/registry.ts';
import { attemptlessBuiltIns, bindFixtures, WorkerFixturePool, type FixtureTarget } from '../../src/run/fixture-pool.ts';
import type { FixtureScope } from '@e2e-dev/core/lib/types';

/** A web-like target, whose attempts are isolated, or a device-like one, whose state outlives them. */
function toyTarget(isolation: 'attempt' | 'worker' = 'attempt'): FixtureTarget {
  return { name: 'toy', platform: 'toy', engine: { name: 'toy', isolation, fixtures: { gadget: () => ({}) } } };
}

/** A fixture that logs its setup, hands `value` over, and logs its teardown. */
function logged(log: string[], name: string, value: unknown, scope: FixtureScope = 'test'): FixtureDefinition {
  return {
    name,
    scope,
    fn: async (_fixtures, use) => {
      log.push(`setup:${name}`);
      await use(value);
      log.push(`teardown:${name}`);
    },
  };
}

/** Binds `chain` for one attempt on `target`, with `builtIns` standing in for the attempt's own fixtures. */
function attempt(chain: readonly FixtureDefinition[], options: { pool?: WorkerFixturePool; signal?: AbortSignal; target?: FixtureTarget; builtIns?: object } = {}) {
  const target = options.target ?? toyTarget();
  return bindFixtures({
    target,
    chain,
    scope: 'test',
    builtIns: options.builtIns ?? { platform: 'toy' },
    pool: options.pool ?? new WorkerFixturePool(target),
    signal: options.signal,
  });
}

describe('test fixtures', () => {
  it('retains cleanup when the attempt aborts immediately after use provides a value', async () => {
    const abort = new AbortController();
    const log: string[] = [];
    const bound = attempt([
      { name: 'ready', scope: 'test', fn: async (_fixtures, use) => {
        const released = use('ready');
        abort.abort();
        await released;
        log.push('teardown:ready');
      } },
      logged(log, 'later', 'later'),
    ], { signal: abort.signal });
    await expect(bound.setUp()).rejects.toMatchObject({ code: 'TEST_SETUP_FAILED' });
    const teardowns = bound.teardowns();
    expect(teardowns.map((teardown) => teardown.name)).toEqual(['ready']);
    await teardowns[0]!.run();
    expect(log).toEqual(['teardown:ready']);
  });

  it('abandons setup on abort before teardown is taken, while keeping a provided fixture for cleanup', async () => {
    const abort = new AbortController();
    let finishSetup!: () => void;
    const waiting = new Promise<void>((resolve) => { finishSetup = resolve; });
    const log: string[] = [];
    const bound = attempt([
      logged(log, 'ready', 'ready'),
      { name: 'slow', scope: 'test', fn: async (_fixtures, use) => {
        log.push('setup:slow');
        await waiting;
        await use('slow');
        log.push('teardown:slow');
      } },
      logged(log, 'later', 'later'),
    ], { signal: abort.signal });
    const continuation = bound.setUp().then(() => { log.push('body'); });
    const stopped = expect(continuation).rejects.toMatchObject({ code: 'TEST_SETUP_FAILED' });
    await vi.waitFor(() => expect(log).toEqual(['setup:ready', 'setup:slow']));
    abort.abort();
    finishSetup();
    await stopped;
    expect(log).toEqual(['setup:ready', 'setup:slow', 'teardown:slow']);
    const teardowns = bound.teardowns();
    expect(teardowns.map((teardown) => teardown.name)).toEqual(['ready']);
    await teardowns[0]!.run();
    expect(log.at(-1)).toBe('teardown:ready');
  });

  it('stops abandoned setup before later fixtures or the body, while releasing the late fixture', async () => {
    const log: string[] = [];
    let finishSetup!: () => void;
    const waiting = new Promise<void>((resolve) => { finishSetup = resolve; });
    const bound = attempt([
      {
        name: 'slow',
        scope: 'test',
        fn: async (_fixtures, use) => {
          log.push('setup:slow');
          await waiting;
          await use('slow');
          log.push('teardown:slow');
        },
      },
      logged(log, 'later', 'later'),
    ]);
    const continuation = bound.setUp().then(() => { log.push('body'); });
    const stopped = expect(continuation).rejects.toMatchObject({ code: 'TEST_SETUP_FAILED' });
    await Promise.resolve();
    expect(bound.teardowns()).toEqual([]);
    finishSetup();
    await stopped;
    expect(log).toEqual(['setup:slow', 'teardown:slow']);
  });

  it('tears down the fixtures set up before a later one throws, last first, and says why the rest are missing', async () => {
    const log: string[] = [];
    const bound = attempt([
      logged(log, 'a', 'A'),
      logged(log, 'b', 'B'),
      {
        name: 'c',
        scope: 'test',
        fn: async () => {
          log.push('setup:c');
          throw new Error('c failed');
        },
      },
      logged(log, 'd', 'D'),
    ]);
    await expect(bound.setUp()).rejects.toThrow('c failed');
    const teardowns = bound.teardowns();
    expect(teardowns.map((teardown) => teardown.name)).toEqual(['b', 'a']);
    for (const teardown of teardowns) await teardown.run();
    expect(log).toEqual(['setup:a', 'setup:b', 'setup:c', 'teardown:b', 'teardown:a']);
    const { a, b } = bound.fixtures as Record<string, unknown>;
    expect([a, b]).toEqual(['A', 'B']);
    // An afterEach hook reading a fixture whose setup failed learns that, not that the fixture is unknown.
    expect(() => (bound.fixtures as Record<string, unknown>)['c']).toThrow(expect.objectContaining({ code: 'TEST_SETUP_FAILED', message: expect.stringContaining('fixture "c" was not set up') }));
  });

  it('refuses a chain fixture named like one the engine contributes', async () => {
    await expect(attempt([logged([], 'gadget', 'mine')]).setUp()).rejects.toMatchObject({
      code: 'TEST_SETUP_FAILED',
      message: expect.stringContaining('fixture "gadget" is contributed by engine toy'),
    });
  });
});

describe('worker fixtures', () => {
  it('sets one instance up for every attempt of the worker and tears it down when the pool closes', async () => {
    const log: string[] = [];
    const target = toyTarget();
    const pool = new WorkerFixturePool(target);
    const database = logged(log, 'database', { rows: 1 }, 'worker');
    const chain = [database, logged(log, 'page', 'P')];
    for (const _ of [1, 2]) {
      const bound = attempt(chain, { pool, target });
      await bound.setUp();
      expect((bound.fixtures as Record<string, unknown>)['database']).toEqual({ rows: 1 });
      for (const teardown of bound.teardowns()) await teardown.run();
    }
    expect(log).toEqual(['setup:database', 'setup:page', 'teardown:page', 'setup:page', 'teardown:page']);
    const teardowns = pool.close();
    expect(teardowns.map((teardown) => teardown.name)).toEqual(['database']);
    for (const teardown of teardowns) await teardown.run();
    expect(log.at(-1)).toBe('teardown:database');
  });

  it('tries a failed setup again for the next attempt that needs it', async () => {
    const target = toyTarget();
    const pool = new WorkerFixturePool(target);
    let tries = 0;
    const flaky: FixtureDefinition = {
      name: 'flaky',
      scope: 'worker',
      fn: async (_fixtures, use) => {
        tries += 1;
        if (tries === 1) throw new Error('first start failed');
        await use(tries);
      },
    };
    await expect(attempt([flaky], { pool, target }).setUp()).rejects.toThrow('first start failed');
    const second = attempt([flaky], { pool, target });
    await second.setUp();
    expect((second.fixtures as Record<string, unknown>)['flaky']).toBe(2);
  });

  it('hands a worker fixture worker fixtures only', async () => {
    const target = toyTarget();
    const seen: string[] = [];
    const chain: FixtureDefinition[] = [
      logged([], 'page', 'P'),
      logged([], 'server', 'S', 'worker'),
      {
        name: 'client',
        scope: 'worker',
        fn: async (fixtures, use) => {
          const { server, platform } = fixtures as Record<string, string>;
          seen.push(`${platform}:${server}`);
          expect(() => (fixtures as Record<string, unknown>)['page']).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('"page" is a test fixture') }));
          expect(() => (fixtures as Record<string, unknown>)['app']).toThrow(expect.objectContaining({ message: expect.stringContaining('"app" is a test fixture') }));
          await use('C');
        },
      },
    ];
    await attempt(chain, { target }).setUp();
    expect(seen).toEqual(['toy:S']);
  });

  it('forwards a device-like built-in to whichever attempt is running', async () => {
    const target = toyTarget('worker');
    const pool = new WorkerFixturePool(target);
    const held: { gadget?: { id(): string } } = {};
    const keeper: FixtureDefinition = {
      name: 'keeper',
      scope: 'worker',
      fn: async (fixtures, use) => {
        held.gadget = (fixtures as { gadget: { id(): string } }).gadget;
        await use('kept');
      },
    };
    const gadgetOf = (id: string) => ({ gadget: { id: () => id }, platform: 'toy' });
    const first = gadgetOf('first');
    const leave = pool.enter(first);
    await attempt([keeper], { pool, target, builtIns: first }).setUp();
    expect(held.gadget?.id()).toBe('first');
    leave();
    pool.enter(gadgetOf('second'));
    expect(held.gadget?.id()).toBe('second');
  });
});

describe('suite hook fixtures', () => {
  it('sets up only the worker fixtures of the chain and refuses test fixtures by scope', async () => {
    const log: string[] = [];
    const target = toyTarget();
    const bound = bindFixtures({
      target,
      chain: [logged(log, 'page', 'P'), logged(log, 'database', 'D', 'worker')],
      scope: 'worker',
      builtIns: attemptlessBuiltIns(target),
      pool: new WorkerFixturePool(target),
    });
    await bound.setUp();
    expect(log).toEqual(['setup:database']);
    const fixtures = bound.fixtures as Record<string, unknown>;
    expect([fixtures['platform'], fixtures['database']]).toEqual(['toy', 'D']);
    for (const name of ['page', 'gadget', 'screen', 'agent']) {
      expect(() => fixtures[name]).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining(`"${name}" is a test fixture`) }));
    }
    expect(() => fixtures['nope']).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('has no "nope" fixture') }));
  });

  it('sees the engine fixtures, app, and screen on an engine whose state outlives an attempt', async () => {
    const target = toyTarget('worker');
    const builtIns = { gadget: 'G', app: 'A', screen: 'S', platform: 'toy', agent: 'never read' };
    const bound = bindFixtures({ target, chain: [], scope: 'worker', builtIns, pool: new WorkerFixturePool(target) });
    const fixtures = bound.fixtures as Record<string, unknown>;
    expect([fixtures['gadget'], fixtures['app'], fixtures['screen']]).toEqual(['G', 'A', 'S']);
    expect(() => fixtures['agent']).toThrow(expect.objectContaining({ message: expect.stringContaining('"agent" is a test fixture') }));
  });
});
