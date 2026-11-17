import { test as base } from 'e2e';

/** A stand-in for state that is expensive to build, such as a seeded account. */
export type Account = { readonly name: string; readonly setups: number };

let setups = 0;

/**
 * `test` with `account`, a worker fixture, and `todo`, a test fixture built on it.
 * Declared outside the test file so the instance outlives the re-import of a
 * serial group or a retry: the pool keys a worker fixture by its definition.
 */
export const test = base
  .extend<{}, { account: Account }>({
    account: [
      async ({ platform }, use) => {
        setups += 1;
        await use({ name: `${platform}-account`, setups });
      },
      { scope: 'worker' },
    ],
  })
  .extend<{ todo: string }>({
    todo: async ({ account }, use) => {
      await use(`Todo for ${account.name}`);
    },
  });
