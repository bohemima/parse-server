import {
  runFind,
  runGet,
  resolvePointer,
  rest,
  connectionResultsArray,
  parseID,
  getGloballyUniqueId,
} from '../execute';
import { getAuthForSessionToken } from '../../Auth';

import {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLInt,
  GraphQLString,
  GraphQLID,
  GraphQLNonNull,
} from 'graphql';

import { queryType, inputType, type, PageInfo } from '../types';

import { Node } from '../types/Node';

import { getOrElse } from '../typesCache';

function handleIdField(fieldName) {
  if (fieldName === 'objectId' || fieldName == 'id') {
    return new GraphQLNonNull(GraphQLID);
  }
}

function getRelationField(fieldName, field, schema) {
  const { find } = loadClass(field.targetClass, schema);
  find.resolve = async (parent, args, context, info) => {
    const query = {
      $relatedTo: {
        object: {
          __type: 'Pointer',
          className: parent.className,
          objectId: parent.objectId,
        },
        key: fieldName,
      },
    };
    args.redirectClassNameForKey = fieldName;
    const results = await runFind(
      context,
      info,
      parent.className,
      args,
      schema,
      query
    );
    results.forEach(result => {
      result.id = getGloballyUniqueId(result.className, result.objectId);
    });
    return connectionResultsArray(results, args, 100);
  };
  return find;
}

function getFieldType(field) {
  return field.type === 'Pointer'
    ? `Pointer<${field.targetClass}>`
    : `${field.type}`;
}

function graphQLField(fieldName, field, schema) {
  if (field.type == 'Relation') {
    return getRelationField(fieldName, field, schema);
  }

  let gQLType = handleIdField(fieldName) || type(field);
  const fieldType = getFieldType(field);
  let gQLResolve;
  if (field.type === 'Pointer') {
    gQLType = loadClass(field.targetClass, schema).objectType;
    gQLResolve = (parent, args, context, info) => {
      return resolvePointer(
        field.targetClass,
        parent[fieldName],
        schema,
        context,
        info
      );
    };
  }
  return {
    name: fieldName,
    type: gQLType,
    resolve: gQLResolve,
    description: `Accessor for ${fieldName} (${fieldType})`,
  };
}

function graphQLInputField(fieldName, field) {
  const gQLType = handleIdField(fieldName) || inputType(field);
  if (!gQLType) {
    return;
  }
  const fieldType = getFieldType(field);
  return {
    name: fieldName,
    type: gQLType,
    description: `Setter for ${fieldName} (${fieldType})`,
  };
}

function graphQLQueryField(fieldName, field, schema) {
  let gQLType = handleIdField(fieldName) || queryType(field);
  if (!gQLType) {
    return;
  }
  if (field.type == 'Pointer') {
    gQLType = loadClass(field.targetClass, schema).queryType;
  }
  return {
    name: fieldName,
    type: gQLType,
    description: `Query for ${fieldName} (${field.type})`,
  };
}

function transformInput(input, schema) {
  const { fields } = schema;
  Object.keys(input).forEach(key => {
    const value = input[key];
    if (fields[key] && fields[key].type === 'Pointer') {
      value.__type = 'Pointer';
    } else if (fields[key] && fields[key].type === 'GeoPoint') {
      value.__type = 'GeoPoint';
    }
  });
  return input;
}

function getObjectId(input) {
  if (!input.id && !input.objectId) {
    throw 'id or objectId are required';
  }
  let objectId;
  if (input.objectId) {
    objectId = input.objectId;
    delete input.objectId;
  } else {
    objectId = parseID(input.id).objectId;
    delete input.id;
  }
  return objectId;
}

export function loadClass(className, schema) {
  const c = getOrElse(className, () => new ParseClass(className, schema));
  const objectType = c.graphQLObjectType();
  const inputType = c.graphQLInputObjectType();
  const updateType = c.graphQLUpdateInputObjectType();
  const queryType = c.graphQLQueryInputObjectType();
  const queryResultType = c.graphQLQueryResultType(objectType);
  const mutationResultType = c.graphQLMutationResultType(objectType);

  const get = {
    type: objectType,
    description: `Use this endpoint to get or query ${className} objects`,
    args: {
      objectId: { type: new GraphQLNonNull(GraphQLID) },
    },
    resolve: async (root, args, context, info) => {
      // Get the selections
      return await runGet(context, info, className, args.objectId, schema);
    },
  };

  const find = {
    type: queryResultType,
    description: `Use this endpoint to get or query ${className} objects`,
    args: {
      where: { type: queryType },
      first: { type: GraphQLInt },
      last: { type: GraphQLInt },
      after: { type: GraphQLString },
      before: { type: GraphQLString },
    },
    resolve: async (root, args, context, info) => {
      // Get the selections
      const results = await runFind(context, info, className, args, schema);
      return connectionResultsArray(results, args, 100);
    },
  };

  const create = {
    type: mutationResultType,
    fields: objectType.fields,
    description: `use this method to create a new ${className}`,
    args: { input: { type: inputType } },
    resolve: async (root, args, context, info) => {
      let { auth } = context;
      const { config } = context;
      const input = transformInput(args.input, schema[className]);
      const clientMutationId = input.clientMutationId;
      delete input.clientMutationId;
      const res = await rest.create(config, auth, className, input);
      if (className === '_User' && res.response && res.response.sessionToken) {
        auth = await getAuthForSessionToken({
          config,
          installationId: context.info && context.info.installationId,
          sessionToken: res.response.sessionToken,
        });
      }
      // Run get to match graphQL style
      const object = await runGet(
        { auth, config },
        info,
        className,
        res.response.objectId
      );
      return { object, clientMutationId };
    },
  };

  const update = {
    type: mutationResultType,
    description: `use this method to update an existing ${className}`,
    args: {
      input: { type: updateType },
    },
    resolve: async (root, args, context, info) => {
      const objectId = getObjectId(args.input);
      const input = transformInput(args.input, schema[className]);
      const clientMutationId = input.clientMutationId;
      delete input.clientMutationId;

      await rest.update(
        context.config,
        context.auth,
        className,
        { objectId },
        input
      );
      // Run get to match graphQL style
      const object = await runGet(context, info, className, objectId);
      return { object, clientMutationId };
    },
  };

  const destroy = {
    type: mutationResultType,
    description: `use this method to update delete an existing ${className}`,
    args: {
      input: {
        type: new GraphQLInputObjectType({
          name: `Destroy${c.displayName}Input`,
          fields: {
            id: {
              type: GraphQLID,
              description: 'Use either the global id or objectId',
            },
            objectId: {
              type: GraphQLID,
              description: 'Use either the global id or objectId',
            },
            clientMutationId: { type: GraphQLString },
          },
        }),
      },
    },
    resolve: async (root, args, context, info) => {
      const objectId = getObjectId(args.input);
      const clientMutationId = args.input.clientMutationId;
      const object = await runGet(context, info, className, objectId);
      await rest.del(context.config, context.auth, className, objectId);
      return { object, clientMutationId };
    },
  };

  return {
    displayName: c.displayName,
    get,
    find,
    create,
    update,
    destroy,
    objectType,
    inputType,
    updateType,
    queryType,
    queryResultType,
    mutationResultType,
    parseClass: c,
  };
}

const reservedFieldNames = ['objectId', 'createdAt', 'updatedAt'];

export class ParseClass {
  schema;
  className;
  class;

  constructor(className, schema) {
    this.className = className;
    this.displayName = className;
    if (this.className.indexOf('_') === 0) {
      this.displayName = this.className.slice(1);
    }
    this.schema = schema;
    this.class = this.schema[className];
    if (!this.class) {
      /* eslint-disable no-console */
      console.warn(
        `Attempting to load a class (${this.className}) that doesn't exist...`
      );
      console.trace();
      /* eslint-enable no-console */
    }
  }

  buildFields(mapper, filterReserved = false, isObject = false) {
    if (!this.class) {
      /* eslint-disable no-console */
      console.warn(
        `Attempting to build fields a class (${
          this.className
        }) that doesn't exist...`
      );
      console.trace();
      /* eslint-enable no-console */
      return;
    }
    const fields = this.class.fields;
    const initial = {};
    if (isObject) {
      initial.id = {
        description: 'A globaly unique identifier.',
        type: new GraphQLNonNull(GraphQLID),
      };
    }
    if (this.className === '_User') {
      initial.sessionToken = {
        description:
          'The session token for the user, set only when it makes sense.',
        type: GraphQLString,
      };
    }
    return Object.keys(fields).reduce((memo, fieldName) => {
      if (filterReserved && reservedFieldNames.indexOf(fieldName) >= 0) {
        return memo;
      }
      const field = fields[fieldName];
      const gQLField = mapper(fieldName, field, this.schema);
      if (!gQLField) {
        return memo;
      }
      memo[fieldName] = gQLField;
      return memo;
    }, initial);
  }

  isTypeOf(object) {
    return object.className === this.className;
  }

  graphQLConfig() {
    const className = this.className;
    return {
      name: this.displayName,
      description: `Parse Class ${className}`,
      // in relay, it's impossible to have 2 interfaces???
      interfaces: [Node /* ParseObjectInterface */],
      fields: () => this.buildFields(graphQLField, false, true),
      isTypeOf: this.isTypeOf.bind(this),
    };
  }

  graphQLQueryConfig() {
    const className = this.className;
    return {
      name: this.displayName + 'Query',
      description: `Parse Class ${className} Query`,
      fields: () => {
        const fields = this.buildFields(graphQLQueryField);
        delete fields.objectId;
        delete fields.id;
        return fields;
      },
      isTypeOf: this.isTypeOf.bind(this),
    };
  }

  graphQLInputConfig() {
    const className = this.className;
    return {
      name: `Add${this.displayName}Input`,
      description: `Parse Class ${className} Input`,
      fields: () => {
        const fields = this.buildFields(graphQLInputField, true);
        fields.clientMutationId = { type: GraphQLString };
        return fields;
      },
      isTypeOf: this.isTypeOf.bind(this),
    };
  }

  graphQLUpdateInputConfig() {
    return {
      name: `Update${this.displayName}Input`,
      description: `Parse Class ${this.className} Update`,
      fields: () => {
        const fields = this.buildFields(graphQLInputField, true);
        fields.id = { type: GraphQLID };
        fields.objectId = { type: GraphQLID };
        fields.clientMutationId = { type: GraphQLString };
        return fields;
      },
      isTypeOf: this.isTypeOf.bind(this),
    };
  }

  graphQLQueryResultConfig() {
    const objectType = this.graphQLObjectType();
    return {
      name: `${this.displayName}QueryConnection`,
      fields: {
        nodes: { type: new GraphQLList(objectType) },
        edges: {
          type: new GraphQLList(
            new GraphQLObjectType({
              name: `${this.displayName}Edge`,
              fields: () => ({
                node: { type: objectType },
                cursor: { type: GraphQLString },
              }),
            })
          ),
        },
        pageInfo: { type: PageInfo },
      },
    };
  }

  graphQLMutationResultConfig() {
    const objectType = this.graphQLObjectType();
    return {
      name: `${this.displayName}MutationCompletePayload`,
      fields: {
        object: { type: objectType },
        clientMutationId: { type: GraphQLString },
      },
    };
  }

  graphQLObjectType() {
    if (!this.objectType) {
      this.objectType = new GraphQLObjectType(this.graphQLConfig());
    }
    return this.objectType;
  }

  graphQLUpdateInputObjectType() {
    if (!this.updateInputObjectType) {
      this.updateInputObjectType = new GraphQLInputObjectType(
        this.graphQLUpdateInputConfig()
      );
    }
    return this.updateInputObjectType;
  }

  graphQLInputObjectType() {
    if (!this.inputObjectType) {
      this.inputObjectType = new GraphQLInputObjectType(
        this.graphQLInputConfig()
      );
    }
    return this.inputObjectType;
  }

  graphQLQueryInputObjectType() {
    if (!this.queryInputObjectType) {
      this.queryInputObjectType = new GraphQLInputObjectType(
        this.graphQLQueryConfig()
      );
    }
    return this.queryInputObjectType;
  }

  graphQLQueryResultType() {
    if (!this.queryResultObjectType) {
      this.queryResultObjectType = new GraphQLObjectType(
        this.graphQLQueryResultConfig()
      );
    }
    return this.queryResultObjectType;
  }

  graphQLMutationResultType() {
    if (!this.mutationResultObjectType) {
      this.mutationResultObjectType = new GraphQLObjectType(
        this.graphQLMutationResultConfig()
      );
    }
    return this.mutationResultObjectType;
  }
}

export function getParseClassQueryFields(schema) {
  return schema.__classNames.reduce((fields, className) => {
    const { get, find, displayName } = loadClass(className, schema);
    return Object.assign(fields, {
      [displayName]: get,
      [`find${displayName}`]: find,
    });
  }, {});
}

export function getParseClassMutationFields(schema) {
  return schema.__classNames.reduce((fields, className) => {
    const { create, update, destroy, displayName } = loadClass(
      className,
      schema
    );
    return Object.assign(fields, {
      [`add${displayName}`]: create,
      [`update${displayName}`]: update,
      [`destroy${displayName}`]: destroy,
    });
  }, {});
}

export default {
  Query: getParseClassQueryFields,
  Mutation: getParseClassMutationFields,
};