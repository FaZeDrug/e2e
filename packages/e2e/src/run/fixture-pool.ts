/**
 * One pool for every fixture a piece of test code reads: the built-in ones
 * (`agent`, `app`, `screen`, `platform`, `session`), the target engine's, and
 * the `test.extend()` chain it was registered through. Each has a scope, and
 * code sees the fixtures that live at least as long as it does: a test and
 * its per-test hooks see test and worker fixtures, a suite hook and a worker
 * fixture see worker fixtures only.
 */

import type { FixtureDefinition } from '../collect/registry.ts';
import type { EngineIsolation } from '@e2e-dev/core/lib/engine/index';
import { pollLineage, type PollLineage } from '@e2e-dev/core/lib/expect/poll-scope';
import { ConfigurationError } from '@e2e-dev/core/lib/internal/errors';
import { didYouMean } from '@e2e-dev/core/lib/internal/suggest';
import type { FixtureScope } from '@e2e-dev/core/lib/types';

/** What the pool reads of a target: its name, its platform, and its engine's fixtures and isolation. */
export interface FixtureTarget {
  readonly name: string;
  readonly platform: string;
  readonly engine?:
    | {
        readonly name: string;
        readonly isolation?: EngineIsolation | undefined;
        readonly fixtures?: Readonly<Record<string, unknown>> | undefined;
      }
    | undefined;
}

/** Built-in fixtures every target has, beside the ones its engine contributes. */
const CORE_FIXTURES = ['agent', 'app', 'screen', 'platform', 'session'] as const;

/** Keys a test body may probe without meaning a fixture. */
const PROBED_KEYS: ReadonlySet<string> = new Set(['then', 'constructor', 'toJSON', 'toString', 'valueOf', 'inspect']);

/**
 * The scope of a built-in fixture on `target`. `platform` never changes and
 * `agent` and `session` belong to one attempt everywhere; the engine's
 * fixtures, `app`, and `screen` live as long as the state behind them, which
 * the engine declares (`isolation`).
 */
function builtInScope(target: FixtureTarget, name: string): FixtureScope {
  if (name === 'platform') return 'worker';
  if (name === 'agent' || name === 'session') return 'test';
  return target.engine?.isolation === 'worker' ? 'worker' : 'test';
}

/** Every built-in fixture name on `target`: the core ones, then the engine's. */
function builtInNames(target: FixtureTarget): readonly string[] {
  return [...CORE_FIXTURES, ...Object.keys(target.engine?.fixtures ?? {})];
}

/**
 * The built-in fixtures of code with no attempt behind it: `platform` alone.
 * Any other name fails the way the attempt's fixture object fails it, unless
 * `unavailable` is given: then a built-in the target does have fails with the
 * error it returns, which says why no attempt is behind the code (a suite
 * hook whose attempt could not open, or one that runs after an interrupt).
 */
export function attemptlessBuiltIns(target: FixtureTarget, unavailable?: (name: string) => Error): object {
  const values = { platform: target.platform };
  return new Proxy(values, {
    get(own, property, receiver) {
      if (typeof property !== 'string' || property in own || PROBED_KEYS.has(property)) return Reflect.get(own, property, receiver) as unknown;
      if (unavailable !== undefined && builtInNames(target).includes(property)) throw unavailable(property);
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `target "${target.name}" has no "${property}" fixture; available: ${builtInNames(target).join(', ')}${didYouMean(property, builtInNames(target))}`,
      );
    },
  });
}

/** One set-up fixture's teardown: the rest of its function after `use`. */
export interface FixtureTeardown {
  readonly name: string;
  run(): Promise<void>;
}

/**
 * Runs one fixture function until it hands its value to `use`. `accept`
 * receives the value and the fixture's teardown synchronously, at `use`; it
 * returns false when nobody can take the value anymore (the attempt that
 * asked gave up), and the function then runs on detached with `use`
 * resolved at once. Resolves once the value was handed over; rejects with
 * the function's failure, or when it returned without calling `use`.
 */
function startFixture(
  definition: FixtureDefinition,
  fixtures: object,
  accept: (value: unknown, teardown: FixtureTeardown) => boolean,
): Promise<void> {
  const { name } = definition;
  let ready!: () => void;
  let failed!: (cause: unknown) => void;
  const provided = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let used = false;
  let misuse: ConfigurationError | undefined;
  // The function's polls are its user's until `use` returns, then its teardown's.
  const polls: PollLineage = pollLineage();
  const use = (value: unknown): Promise<void> => {
    if (used) {
      misuse = new ConfigurationError(
        'TEST_SETUP_FAILED',
        `fixture "${name}" called use() twice; a fixture hands one value per instance`,
      );
      const rejected = Promise.reject(misuse);
      // The violation is reported at teardown whether or not the fixture awaits this.
      rejected.catch(() => undefined);
      return rejected;
    }
    used = true;
    const teardown: FixtureTeardown = {
      name,
      run: async () => {
        polls.handOver();
        release();
        await run;
        if (misuse !== undefined) throw misuse;
      },
    };
    if (!accept(value, teardown)) {
      // Nobody can take the value, and holding the function here would keep
      // whatever it allocated alive forever.
      release();
    }
    ready();
    return released;
  };
  const run = Promise.resolve()
    .then(() => polls.run(() => definition.fn(fixtures, use)))
    .then(
      () => {
        if (!used) {
          failed(
            new ConfigurationError(
              'TEST_SETUP_FAILED',
              `fixture "${name}" returned without calling use(); a fixture awaits use(value) to hand its value over`,
            ),
          );
        }
      },
      (cause: unknown) => {
        failed(cause);
        throw cause;
      },
    );
  // A fixture whose setup failed is never torn down, and one released
  // detached runs on alone, so nothing else would observe its rejection; a
  // torn-down one is awaited by its teardown.
  run.catch(() => undefined);
  return provided;
}

/**
 * The worker-scoped `test.extend()` fixtures of one worker and target: one
 * instance per definition, set up the first time a test or suite hook of
 * its chain needs it, and torn down when the worker ends. A definition the
 * test file itself declares is a new definition each time the file is
 * imported again (after a failed test, for a serial group or a setup test),
 * so it gets a new instance; one declared in a module the file imports keeps
 * its instance.
 */
export class WorkerFixturePool {
  private readonly instances = new Map<FixtureDefinition, Promise<unknown>>();
  private readonly active: FixtureTeardown[] = [];
  private closed = false;
  /** The built-in fixtures of the attempt or suite hook running now; see `enter`. */
  private current: object | undefined;

  constructor(private readonly target: FixtureTarget) {}

  /**
   * Makes `builtIns` the fixtures a worker fixture's built-ins forward to,
   * until the returned function restores the previous ones. A worker
   * fixture outlives the attempt it was set up in, so it holds a forwarder
   * for `device`, `app`, and `screen`, never one attempt's object: the steps
   * it takes land in the record of whatever runs at the time.
   */
  enter(builtIns: object): () => void {
    const previous = this.current;
    this.current = builtIns;
    return () => {
      this.current = previous;
    };
  }

  /**
   * The value of `definition`, set up on first use with `fixtures`, the
   * worker fixtures its chain declares before it. A setup that fails is
   * forgotten, so the next test to need the fixture tries again; one still
   * running is shared by everyone who asks meanwhile.
   */
  acquire(definition: FixtureDefinition, fixtures: object): Promise<unknown> {
    const known = this.instances.get(definition);
    if (known !== undefined) return known;
    let value: unknown;
    const instance = startFixture(definition, fixtures, (provided, teardown) => {
      if (this.closed) return false;
      value = provided;
      this.active.push(teardown);
      return true;
    }).then(() => value);
    this.instances.set(definition, instance);
    instance.catch(() => {
      if (this.instances.get(definition) === instance) this.instances.delete(definition);
    });
    return instance;
  }

  /**
   * Ends the pool: the teardowns of every fixture whose setup completed, last
   * set up first. A setup still running when the pool closes finds nobody to
   * hand its value to, and its teardown runs detached.
   */
  close(): readonly FixtureTeardown[] {
    this.closed = true;
    this.instances.clear();
    return this.active.splice(0).toReversed();
  }

  /**
   * The built-in worker fixtures as a worker fixture sees them: `platform`
   * as is, every other one forwarding to the attempt or suite hook running
   * at the time it is read.
   */
  builtIns(): Record<string, unknown> {
    const values: Record<string, unknown> = { platform: this.target.platform };
    for (const name of builtInNames(this.target)) {
      if (name === 'platform' || builtInScope(this.target, name) !== 'worker') continue;
      values[name] = this.forwarder(name);
    }
    return values;
  }

  /** An object that reads `name` off the running attempt's fixtures at each access. */
  private forwarder(name: string): object {
    const resolve = (): object => {
      const current = this.current;
      if (current === undefined) {
        throw new ConfigurationError(
          'UNSUPPORTED_CAPABILITY',
          `a worker fixture used "${name}" when no test or suite hook was running`,
        );
      }
      return Reflect.get(current, name) as object;
    };
    return new Proxy(
      {},
      {
        get: (_, key) => {
          const target = resolve();
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
        has: (_, key) => Reflect.has(resolve(), key),
      },
    );
  }
}

/** What one piece of user code receives, and the fixtures set up for it. */
export interface BoundFixtures {
  /** The object the hooks and the body receive. */
  readonly fixtures: object;
  /**
   * Sets up the chain in declaration order: a worker fixture is taken from
   * the pool (set up there on first use), a test fixture set up for this
   * attempt. Each value is defined on `fixtures` before the next definition,
   * the hooks, or the body can read it. Rejects with the first failure; the
   * test fixtures set up before it still get torn down.
   */
  setUp(): Promise<void>;
  /**
   * The teardowns of the test fixtures whose setup completed, last set up
   * first. Taking them ends setup, as does `signal`: a test fixture still
   * running that reaches `use` afterwards finds no attempt to hand its value
   * to, so `use` resolves at once and its teardown runs detached. Worker
   * fixtures are the pool's to tear down.
   */
  teardowns(): readonly FixtureTeardown[];
}

export interface BindOptions {
  readonly target: FixtureTarget;
  /** The `test.extend()` chain the code was registered through. */
  readonly chain: readonly FixtureDefinition[];
  /** `test` for an attempt (its hooks and body), `worker` for a suite hook. */
  readonly scope: FixtureScope;
  /** The attempt's built-in fixtures, which the result reads lazily; see `attemptlessBuiltIns`. */
  readonly builtIns: object;
  readonly pool: WorkerFixturePool;
  /** The attempt's abort signal: setup stops once it fires. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Binds one chain to the code about to run with it: a test attempt, or a
 * suite hook. The result reads the built-ins the scope admits lazily, and
 * holds the chain's fixtures as they are set up. A fixture the scope does
 * not admit, or one whose setup failed, fails at the first read with what
 * went wrong instead of looking unknown.
 */
export function bindFixtures(options: BindOptions): BoundFixtures {
  const { target, chain, scope, builtIns, pool, signal } = options;
  const values: Record<string, unknown> = {};
  const fixtures = gate(values, options);
  const builtInSet = new Set(builtInNames(target));
  for (const name of builtInSet) {
    if (scope === 'worker' && builtInScope(target, name) === 'test') continue;
    Object.defineProperty(values, name, { enumerable: true, get: () => Reflect.get(builtIns, name) as unknown });
  }
  // What a worker fixture sees: the built-in worker fixtures and the worker
  // fixtures declared before it.
  const workerValues = pool.builtIns();
  const workerFixtures = gate(workerValues, { ...options, scope: 'worker', builtIns: attemptlessBuiltIns(target) });

  const active: FixtureTeardown[] = [];
  let abandoned = signal?.aborted === true;
  const abandon = (): void => {
    abandoned = true;
  };
  if (!abandoned) signal?.addEventListener('abort', abandon, { once: true });
  /** Stops setup once its attempt has given up on it. */
  const requireActive = (): void => {
    if (abandoned) throw new ConfigurationError('TEST_SETUP_FAILED', 'fixture setup ended after the attempt was abandoned');
  };
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(values, name, { value, enumerable: true });
  };

  const setUpOne = async (definition: FixtureDefinition): Promise<void> => {
    const { name } = definition;
    // A suite hook sets up none of the test fixtures its chain holds.
    if (scope === 'worker' && definition.scope === 'test') return;
    if (builtInSet.has(name)) {
      throw new ConfigurationError(
        'TEST_SETUP_FAILED',
        `fixture "${name}" is contributed by engine ${target.engine?.name ?? 'none'}; test.extend() cannot redefine it`,
      );
    }
    if (definition.scope === 'worker') {
      const value = await pool.acquire(definition, workerFixtures);
      Object.defineProperty(workerValues, name, { value, enumerable: true });
      define(name, value);
      return;
    }
    await startFixture(definition, fixtures, (value, teardown) => {
      if (abandoned) return false;
      define(name, value);
      active.push(teardown);
      return true;
    });
  };

  return {
    fixtures,
    async setUp(): Promise<void> {
      requireActive();
      for (const definition of chain) {
        await setUpOne(definition);
        requireActive();
      }
    },
    teardowns(): readonly FixtureTeardown[] {
      abandon();
      signal?.removeEventListener('abort', abandon);
      return active.toReversed();
    },
  };
}

/**
 * Wraps `values` so a read of a fixture they lack says why: a test fixture
 * read where only worker fixtures live, or a chain fixture whose setup
 * failed or has not run. Any other name goes to the built-ins, whose own
 * gate names the fixtures the target has.
 */
function gate(values: Record<string, unknown>, options: BindOptions): object {
  const { target, chain, scope, builtIns } = options;
  const declared = new Map(chain.map((definition) => [definition.name, definition.scope]));
  return new Proxy(values, {
    get(own, property, receiver) {
      if (typeof property !== 'string' || property in own || PROBED_KEYS.has(property)) {
        return Reflect.get(own, property, receiver) as unknown;
      }
      const fixtureScope = declared.get(property) ?? (builtInNames(target).includes(property) ? builtInScope(target, property) : undefined);
      if (scope === 'worker' && fixtureScope === 'test') {
        throw new ConfigurationError(
          'UNSUPPORTED_CAPABILITY',
          `"${property}" is a test fixture on target "${target.name}": beforeAll, afterAll, and worker fixtures see worker fixtures only, since a test fixture is set up for one test. Use it in beforeEach, or save the state it builds with test.setup()`,
        );
      }
      if (declared.has(property)) {
        throw new ConfigurationError(
          'TEST_SETUP_FAILED',
          `fixture "${property}" was not set up: its setup failed, or it is declared after the fixture reading it`,
        );
      }
      return Reflect.get(builtIns, property) as unknown;
    },
  });
}
