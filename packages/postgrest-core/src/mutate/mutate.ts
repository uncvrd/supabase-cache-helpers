import { buildDeleteMutatorFn } from './build-delete-mutator-fn';
import { buildUpsertMutatorFn } from './build-upsert-mutator-fn';
import {
  DecodedKey,
  MutatorFn,
  PostgrestMutatorOpts,
  UpsertMutatorConfig,
} from '../lib/mutator-types';
import { parseOrderByKey } from '../lib/parse-order-by-key';
import { PostgrestFilter } from '../postgrest-filter';
import { PostgrestQueryParserOptions } from '../postgrest-query-parser';

export type OperationType = 'UPSERT' | 'DELETE';

/**
 * Defines the operation
 */
export type Operation<Type extends Record<string, unknown>> = {
  table: string;
  schema: string;
  input: Type;
  opts?: PostgrestMutatorOpts<Type>;
  type: 'UPSERT' | 'DELETE';
  primaryKeys: (keyof Type)[];
};

export type Cache<KeyType, Type extends Record<string, unknown>> = {
  /**
   * The keys currently present in the cache
   */
  cacheKeys: KeyType[];
  /**
   * Should return a PostgrestFilter for the given query.
   * This is exposed as a function so results can be cached by the cache library.
   */
  getPostgrestFilter: (
    query: string,
    opts?: PostgrestQueryParserOptions,
  ) => Pick<
    PostgrestFilter<Type>,
    | 'apply'
    | 'hasPaths'
    | 'applyFilters'
    | 'denormalize'
    | 'hasFiltersOnPaths'
    | 'applyFiltersOnPaths'
  >;
  /**
   * Decode a key. Should return null if not a PostgREST key.
   */
  decode: (k: KeyType) => DecodedKey | null;
  /**
   * The mutation function from the cache library
   */
  mutate: (key: KeyType, fn?: MutatorFn<Type>) => Promise<void> | void;
};

export const mutate = async <KeyType, Type extends Record<string, unknown>>(
  op: Operation<Type>,
  cache: Cache<KeyType, Type>,
  config?: UpsertMutatorConfig<Type>,
) => {
  const { input, type, opts, schema, table } = op;
  const { cacheKeys, decode, getPostgrestFilter, mutate } = cache;

  const mutations = [];
  for (const k of cacheKeys) {
    const key = decode(k);

    // Exit early if not a postgrest key
    if (!key) continue;
    if (key.schema === schema && key.table === table) {
      // For upsert, the input has to have either all required paths or all required filters
      if (type === 'UPSERT') {
        const filter = getPostgrestFilter(key.queryKey);
        // parse input into expected target format
        const transformedInput = filter.denormalize(input);
        if (
          filter.applyFilters(transformedInput) ||
          // also allow upsert if either the filter does not apply eq filters on any pk
          !filter.hasFiltersOnPaths(op.primaryKeys as string[]) ||
          // or input matches all pk filters
          filter.applyFiltersOnPaths(
            transformedInput,
            op.primaryKeys as string[],
          )
        ) {
          mutations.push(
            mutate(
              k,
              buildUpsertMutatorFn(
                transformedInput as Type,
                op.primaryKeys as (keyof Type)[],
                filter,
                {
                  limit: key.limit,
                  orderBy: key.orderByKey
                    ? parseOrderByKey(key.orderByKey)
                    : undefined,
                },
                config,
              ),
            ),
          );
        }
        // For upsert, the input has to have a value for all primary keys
      } else if (
        type === 'DELETE' &&
        op.primaryKeys.every((pk) => typeof input[pk] !== 'undefined')
      ) {
        mutations.push(
          mutate(
            k,
            buildDeleteMutatorFn(input, op.primaryKeys as (keyof Type)[]),
          ),
        );
      }
    }

    for (const r of opts?.revalidateRelations ?? []) {
      if (
        (!r.schema || r.schema === key.schema) &&
        r.relation === key.table &&
        getPostgrestFilter(key.queryKey, {
          exclusivePaths: [r.relationIdColumn],
        }).applyFilters({
          [r.relationIdColumn]: input[r.fKeyColumn],
        })
      ) {
        mutations.push(mutate(k));
      }
    }

    if (
      opts?.revalidateTables?.find(
        (t) => (!t.schema || t.schema === key.schema) && t.table === key.table,
      )
    ) {
      mutations.push(mutate(k));
    }
  }
  await Promise.all(mutations);
};
