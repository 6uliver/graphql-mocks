import { Server as MirageServer } from 'miragejs';
import { isScalarType } from 'graphql';
import { Resolver } from '../../types';
import { MirageGraphQLMapper } from '../mapper/mapper';
import { relayPaginateNodes } from '../../relay/utils';
import { cleanRelayConnectionName, mirageCursorForNode } from './utils';
import { extractDependencies } from '../../resolver/extract-dependencies';
import { AutoResolverError } from '../auto-resolver-error';
import { unwrap } from '../../graphql/utils';
import { coerceToList, coerceReturnType } from '../../resolver/utils';
import { RootQueryResolverMatch, AutoResolverErrorMeta } from '../types';

function findMatchingModelsForType({
  type,
  mirageMapper,
  mirageServer,
}: // eslint-disable-next-line @typescript-eslint/no-explicit-any
any): RootQueryResolverMatch {
  type = unwrap(type);
  const mappedModelName = mirageMapper && type.name && mirageMapper.findMatchForType(type.name);

  // model candidates are ordered in terms of preference:
  // [0] A manual type mapping already exists
  // [1] A model exists for a relay type name
  // [2] The type's name itself exists as a model name
  const modelNameCandidates = [mappedModelName, cleanRelayConnectionName(type.name), type.name].filter(Boolean);

  const matchedModelName = modelNameCandidates.find((candidate) => {
    try {
      // try each candidate in the schema
      return Boolean(mirageServer.schema.collectionForType(candidate));
    } catch {
      // nope; no match
      return false;
    }
  });

  let models = [];
  try {
    models = mirageServer.schema.all(matchedModelName)?.models;
  } catch (e) {
    throw new Error(
      `Unable to look up collection for ${matchedModelName} on mirage schema, received error:\n${e.message}`,
    );
  }

  return {
    models,
    matchedModelName,
    modelNameCandidates,
  };
}

export const mirageRootQueryResolver: Resolver = function mirageRootQueryResolver(parent, args, context, info) {
  const { returnType, fieldName, parentType } = info;
  const isRelayPaginated = unwrap(returnType)?.name?.endsWith('Connection');
  const { mirageMapper, mirageServer } = extractDependencies<{
    mirageMapper: MirageGraphQLMapper;
    mirageServer: MirageServer;
  }>(context, ['mirageMapper', 'mirageServer'], { required: false });

  const fieldFilter = mirageMapper?.findFieldFilter([parentType.name, fieldName]);

  const errorMeta: AutoResolverErrorMeta = {
    parent,
    args,
    info,
    context,
    autoResolverType: 'ROOT_TYPE',
    isRelay: isRelayPaginated,
    usedFieldFilter: false,
    hasFieldFilter: Boolean(fieldFilter),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any = null;
  const hasScalarInReturnType = isScalarType(unwrap(returnType));

  // Root query types that return scalars cannot use mirage models
  // since models represent an object with attributes.
  // We have to throw an error and recommend a field filter (or resolver in map)
  if (hasScalarInReturnType && !fieldFilter) {
    throw new Error(
      `Scalars cannot be auto-resolved with mirage from the root query type. ${
        parentType.name
      }.${fieldName} resolves to a scalar, or a list, of type ${
        unwrap(returnType).name
      }. Try adding a field filter for this field and returning a value for this field.`,
    );
  }

  if (!hasScalarInReturnType) {
    // at this point we are querying on a query root type:
    // * there is no parent on root query types
    // * we are querying for something non-scalar (so we can use mirage)
    // * we can use the mappings to assist in finding something from mirage
    const match = findMatchingModelsForType({ type: returnType, mirageMapper, mirageServer });
    errorMeta.match = match;
    result = match.models;
  }

  try {
    if (fieldFilter) {
      result = fieldFilter(coerceToList(result) ?? [], parent, args, context, info);
      errorMeta.usedFieldFilter = true;
    }

    if (isRelayPaginated) {
      const nodes = coerceToList(result);
      return nodes && relayPaginateNodes(nodes, args, mirageCursorForNode);
    }

    return coerceReturnType(result, info);
  } catch (error) {
    throw new AutoResolverError(error, errorMeta);
  }
};
