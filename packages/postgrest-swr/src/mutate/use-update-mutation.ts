import { PostgrestError, PostgrestQueryBuilder } from '@supabase/postgrest-js';
import { GetResult } from '@supabase/postgrest-js/dist/module/select-query-parser';
import {
  GenericSchema,
  GenericTable,
} from '@supabase/postgrest-js/dist/module/types';
import {
  buildUpdateFetcher,
  getTable,
  QueryWithoutWildcard,
} from '@supabase-cache-helpers/postgrest-core';
import useSWRMutation, { SWRMutationResponse } from 'swr/mutation';

import { UsePostgrestSWRMutationOpts } from './types';
import { useRandomKey } from './use-random-key';
import { useUpsertItem } from '../cache';
import { useQueriesForTableLoader } from '../lib';

/**
 * Hook for performing an UPDATE mutation on a PostgREST resource.
 *
 * @param qb - The PostgrestQueryBuilder instance for the resource.
 * @param primaryKeys - An array of primary key column names for the table.
 * @param query - An optional query string.
 * @param opts - An optional object of options to configure the mutation.
 * @returns A SWRMutationResponse object containing the mutation response data, error, and mutation function.
 */
function useUpdateMutation<
  S extends GenericSchema,
  T extends GenericTable,
  Re = T extends { Relationships: infer R } ? R : unknown,
  Q extends string = '*',
  R = GetResult<S, T['Row'], Re, Q extends '*' ? '*' : Q>,
>(
  qb: PostgrestQueryBuilder<S, T, Re>,
  primaryKeys: (keyof T['Row'])[],
  query?: QueryWithoutWildcard<Q> | null,
  opts?: UsePostgrestSWRMutationOpts<S, T, Re, 'UpdateOne', Q, R>,
): SWRMutationResponse<R | null, PostgrestError, string, T['Update']> {
  const key = useRandomKey();
  const queriesForTable = useQueriesForTableLoader(getTable(qb));
  const upsertItem = useUpsertItem({
    primaryKeys,
    table: getTable(qb),
    schema: qb.schema as string,
    opts,
    ...opts,
  });

  return useSWRMutation<R | null, PostgrestError, string, T['Update']>(
    key,
    async (_, { arg }) => {
      const result = await buildUpdateFetcher<S, T, Re, Q, R>(qb, primaryKeys, {
        query: query ?? undefined,
        queriesForTable,
        disabled: opts?.disableAutoQuery,
        ...opts,
      })(arg);

      if (result?.normalizedData) {
        upsertItem(result?.normalizedData as T['Row']);
      }
      return result?.userQueryData ?? null;
    },
    opts,
  );
}

export { useUpdateMutation };
