/**
 * Which fixtures a piece of test code needs, and in what order: the ones its
 * functions name, the ones those fixtures name in turn, and the `auto` ones.
 * Planning runs no fixture, so the rules it enforces (a name the target has,
 * a suite hook or worker fixture that reads worker fixtures only, no cycle)
 * fail at collection, and again in the worker before anything is set up.
 */

import type { EngineIsolation } from '@e2e-dev/core/lib/engine/index';
import { unknownFixtureMessage } from '@e2e-dev/core/lib/run/fixtures';
import type { FixtureScope } from '@e2e-dev/core/lib/types';
import type { SourceLocation } from '@e2e-dev/core/lib/internal/source';
import { fixtureNames, FixtureUseError, type FixtureUserFn } from './fixture-names.ts';
import type { FixtureDefinition, RegisteredHook, RegisteredTest, SuiteHook, TestHook } from './registry.ts';

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

/**
 * The scope of a built-in fixture on `target`. `platform` never changes and
 * `agent` and `session` belong to one attempt everywhere; the engine's
 * fixtures, `app`, and `screen` live as long as the state behind them, which
 * the engine declares (`isolation`).
 */
export function builtInScope(target: FixtureTarget, name: string): FixtureScope {
  if (name === 'platform') return 'worker';
  if (name === 'agent' || name === 'session') return 'test';
  return target.engine?.isolation === 'worker' ? 'worker' : 'test';
}

/** Every built-in fixture name on `target`: the core ones, then the engine's. */
export function builtInNames(target: FixtureTarget): readonly string[] {
  return [...CORE_FIXTURES, ...Object.keys(target.engine?.fixtures ?? {})];
}

/** One function that receives fixtures, and how an error names it. */
interface FixtureUser {
  /** The subject of an error about it: `test "signs in"`, `beforeEach hook`, `fixture "database"`. */
  readonly what: string;
  readonly fn: FixtureUserFn;
  /** Where it was registered. */
  readonly source?: SourceLocation | undefined;
}

/** A test body as a fixture user. */
function testUser(test: Pick<RegisteredTest, 'kind' | 'titlePath' | 'fn' | 'source'>): FixtureUser {
  return { what: `${test.kind === 'setup' ? 'setup test' : 'test'} ${JSON.stringify(test.titlePath.join(' > '))}`, fn: test.fn, source: test.source };
}

/** A hook as a fixture user. */
function hookUser(hook: Pick<RegisteredHook, 'kind' | 'fn' | 'source'>): FixtureUser {
  return { what: `${hook.kind} hook`, fn: hook.fn, source: hook.source };
}

/** A `test.extend()` fixture function as a fixture user: its first parameter is what it depends on. */
function definitionUser(definition: FixtureDefinition): FixtureUser {
  return { what: `${definition.scope === 'worker' ? 'worker fixture' : 'fixture'} "${definition.name}"`, fn: definition.fn, source: definition.source };
}

/** What to set up for one piece of test code, and whether it reaches the engine. */
export interface FixturePlan {
  readonly target: FixtureTarget;
  /** The `test.extend()` chain the plan was made over. */
  readonly chain: readonly FixtureDefinition[];
  /** `test` for an attempt (its hooks and body), `worker` for a suite hook. */
  readonly scope: FixtureScope;
  /** The chain's fixtures to set up: in declaration order, each after the fixtures it names. */
  readonly order: readonly FixtureDefinition[];
  /**
   * Whether the code, or a fixture it needs, names a built-in fixture the
   * engine backs: any but `platform`. Code that names none never touches the
   * engine, so a suite hook needs no attempt for it.
   */
  readonly usesEngine: boolean;
  /** The planned fixtures that name an engine-backed built-in, themselves or through a fixture they name. */
  readonly engineBacked: ReadonlySet<FixtureDefinition>;
}

/** The fixtures of one chain, by name, on one target; no target while a `test.extend()` call is checked. */
interface Pool {
  readonly target: FixtureTarget | undefined;
  readonly byName: ReadonlyMap<string, FixtureDefinition>;
}

/** What one name a function reads resolved to. */
type Dependency = { readonly definition: FixtureDefinition } | { readonly definition?: undefined; readonly engineBacked: boolean };

/** Walks the fixtures a plan needs, each after the fixtures it names. */
class Planner {
  readonly order: FixtureDefinition[] = [];
  readonly engineBacked = new Set<FixtureDefinition>();
  private readonly state = new Map<FixtureDefinition, 'visiting' | 'done'>();

  constructor(private readonly pool: Pool) {}

  /**
   * Resolves `name`, which `user` reads. `scope` is how long `user` lives: a
   * suite hook or a worker fixture (`worker`) cannot read a test fixture.
   * `from` is the fixture reading it, which sees the fixtures of its own
   * `test.extend()` call and of the ones before it.
   */
  read(name: string, user: FixtureUser, scope: FixtureScope, from?: FixtureDefinition): Dependency {
    const { target, byName } = this.pool;
    const declared = byName.get(name);
    const definition = declared !== undefined && (from === undefined || declared.layer <= from.layer) ? declared : undefined;
    let fixtureScope: FixtureScope | undefined;
    if (definition !== undefined) fixtureScope = definition.scope;
    else if (target === undefined) {
      // Before a target is known, a name the chain lacks may be an engine's, and `app` and `screen` have the engine's scope.
      fixtureScope = name === 'platform' ? 'worker' : name === 'agent' || name === 'session' ? 'test' : undefined;
    } else if (builtInNames(target).includes(name)) fixtureScope = builtInScope(target, name);
    else if (declared !== undefined) {
      throw new FixtureUseError(
        `${user.what} names "${name}", which a later test.extend() declares: a fixture sees the fixtures of its own extend() call and of the ones before it`,
        user.source,
      );
    } else {
      const available = [...builtInNames(target), ...[...byName.values()].filter((each) => from === undefined || each.layer <= from.layer).map((each) => each.name)];
      throw new FixtureUseError(`${user.what} names "${name}": ${unknownFixtureMessage(target, name, available.toSorted())}`, user.source);
    }
    if (scope === 'worker' && fixtureScope === 'test') {
      throw new FixtureUseError(
        `${user.what} names "${name}", a test fixture${target === undefined ? '' : ` on target "${target.name}"`}: beforeAll, afterAll, and worker fixtures see worker fixtures only, since a test fixture is set up for one test. Use it in beforeEach, or save the state it builds with test.setup()`,
        user.source,
      );
    }
    return definition === undefined ? { engineBacked: name !== 'platform' } : { definition };
  }

  /** Plans `definition` after the fixtures it names. `path` is the fixtures that led here, outermost first. */
  visit(definition: FixtureDefinition, path: readonly FixtureDefinition[] = []): void {
    const state = this.state.get(definition);
    if (state === 'done') return;
    if (state === 'visiting') {
      const cycle = [...path.slice(path.indexOf(definition)), definition].map((each) => `"${each.name}"`).join(' -> ');
      throw new FixtureUseError(`fixtures depend on each other in a cycle: ${cycle}. A fixture cannot name one that needs it`, definition.source);
    }
    this.state.set(definition, 'visiting');
    const user = definitionUser(definition);
    for (const name of fixtureNames(user.fn, user.what, user.source)) {
      const dependency = this.read(name, user, definition.scope, definition);
      if (dependency.definition === undefined) {
        if (dependency.engineBacked) this.engineBacked.add(definition);
        continue;
      }
      this.visit(dependency.definition, [...path, definition]);
      if (this.engineBacked.has(dependency.definition)) this.engineBacked.add(definition);
    }
    this.state.set(definition, 'done');
    this.order.push(definition);
  }
}

function poolOf(target: FixtureTarget | undefined, chain: readonly FixtureDefinition[]): Pool {
  return { target, byName: new Map(chain.map((definition) => [definition.name, definition])) };
}

/**
 * Checks the fixtures one `test.extend()` call added (`added`, the end of
 * `chain`) as far as they can be before a target is known: each function
 * destructures its first parameter, no fixture needs itself, and a worker
 * fixture names no test fixture of the chain, `agent`, or `session`.
 */
export function checkDeclaredFixtures(chain: readonly FixtureDefinition[], added: readonly FixtureDefinition[]): void {
  const planner = new Planner(poolOf(undefined, chain));
  for (const definition of added) planner.visit(definition);
}

interface PlanRequest {
  readonly target: FixtureTarget;
  readonly chain: readonly FixtureDefinition[];
  readonly scope: FixtureScope;
  /** The functions about to run with the fixtures. */
  readonly users: readonly FixtureUser[];
}

/**
 * Plans the fixtures of `chain` that `users` need on `target`: the ones they
 * name, the ones those name, and the `auto` ones (a suite hook sets up no
 * test fixture, `auto` or not). Throws a `FixtureUseError`, before anything
 * is set up, for a name the target has no fixture for, a test fixture named
 * by a suite hook or a worker fixture, a cycle, and a chain fixture named
 * like one the target's engine contributes.
 */
function planFixtures(request: PlanRequest): FixturePlan {
  const { target, chain, scope, users } = request;
  const engineFixtures = Object.keys(target.engine?.fixtures ?? {});
  for (const definition of chain) {
    if (!engineFixtures.includes(definition.name)) continue;
    throw new FixtureUseError(
      `fixture "${definition.name}" is contributed by engine ${target.engine?.name ?? 'none'} on target "${target.name}"; test.extend() cannot redefine it`,
      definition.source,
    );
  }
  const pool = poolOf(target, chain);
  const reach = new Planner(pool);
  const named = new Set(chain.filter((definition) => definition.auto && (scope === 'test' || definition.scope === 'worker')));
  let usesEngine = false;
  for (const user of users) {
    for (const name of fixtureNames(user.fn, user.what, user.source)) {
      const dependency = reach.read(name, user, scope);
      if (dependency.definition === undefined) usesEngine ||= dependency.engineBacked;
      else named.add(dependency.definition);
    }
  }
  for (const definition of named) reach.visit(definition);
  usesEngine ||= [...named].some((definition) => reach.engineBacked.has(definition));
  // Declaration order over everything reached, so a fixture's place does not
  // depend on who named it, and a suite that names every fixture sets them
  // up as it did before setup was on demand.
  const needed = new Set(reach.order);
  const ordered = new Planner(pool);
  for (const definition of chain) if (needed.has(definition)) ordered.visit(definition);
  return { target, chain, scope, order: ordered.order, usesEngine, engineBacked: reach.engineBacked };
}

/**
 * The plan of one test attempt, resolved as one unit: what the body and
 * every `beforeEach` and `afterEach` hook that applies name, over the test's
 * own chain. A fixture only an `afterEach` names is set up before the first
 * `beforeEach`, never on the cleanup budget.
 */
export function planAttempt(target: FixtureTarget, test: Pick<RegisteredTest, 'kind' | 'titlePath' | 'fn' | 'source' | 'fixtures'>, hooks: readonly TestHook[]): FixturePlan {
  return planFixtures({ target, chain: test.fixtures, scope: 'test', users: [...hooks.map(hookUser), testUser(test)] });
}

/** The plan of one `beforeAll` or `afterAll` hook, over the chain it was registered through. */
export function planSuiteHook(target: FixtureTarget, hook: SuiteHook): FixturePlan {
  return planFixtures({ target, chain: hook.fixtures, scope: 'worker', users: [hookUser(hook)] });
}
