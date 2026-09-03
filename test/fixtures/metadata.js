export const cleanMetadata = {
  serverVersion: "16.4",
  serverVersionNum: "160004",
  viewCount: 0,
  functionCount: 0,
  extensionCount: 1,
  enums: [],
  tables: [
    {
      schema: "public",
      name: "accounts",
      relationKind: "r",
      rlsEnabled: false,
      rlsForced: false,
      isPartition: false,
      hasPartitions: false,
      persistence: "p",
      estimatedRows: "2",
      policyCount: 0,
      triggerCount: 0,
      columns: [
        column(1, "id", "integer", "int4", { notNull: true, defaultExpression: "nextval('accounts_id_seq'::regclass)" }),
        column(2, "display_name", "text", "text", { notNull: true }),
      ],
      constraints: [constraint("accounts_pkey", "p", ["id"])],
      indexes: [primaryIndex("accounts_pkey", ["id"])],
    },
    {
      schema: "public",
      name: "items",
      relationKind: "r",
      rlsEnabled: false,
      rlsForced: false,
      isPartition: false,
      hasPartitions: false,
      persistence: "p",
      estimatedRows: "1",
      policyCount: 0,
      triggerCount: 0,
      columns: [
        column(1, "id", "integer", "int4", { notNull: true }),
        column(2, "account_id", "integer", "int4", { notNull: true }),
        column(3, "payload", "jsonb", "jsonb", { notNull: true, typeCategory: "U" }),
        column(4, "active", "boolean", "bool", { notNull: true, defaultExpression: "true" }),
      ],
      constraints: [
        constraint("items_pkey", "p", ["id"]),
        {
          ...constraint("items_account_id_fkey", "f", ["account_id"]),
          referencedSchema: "public",
          referencedTable: "accounts",
          referencedColumns: ["id"],
          updateAction: "a",
          deleteAction: "c",
          matchType: "s",
          deferrable: false,
          initiallyDeferred: false,
          validated: true,
        },
      ],
      indexes: [
        primaryIndex("items_pkey", ["id"]),
        {
          name: "items_account_id_idx",
          method: "btree",
          unique: false,
          primary: false,
          valid: true,
          ready: true,
          keyCount: 1,
          totalColumnCount: 1,
          hasPredicate: false,
          hasExpressions: false,
          backsConstraint: false,
          keys: [{ name: "account_id" }],
        },
      ],
    },
  ],
};

export const defaultOptions = {
  schemas: ["public"],
  include: [],
  exclude: [],
  namespace: "auto",
  numeric: "text",
  externalFks: "drop",
  unknownTypes: "error",
  strict: false,
};

function column(position, name, formattedType, udtName, overrides = {}) {
  return {
    position,
    name,
    formattedType,
    udtName,
    typeSchema: "pg_catalog",
    typeKind: "b",
    typeCategory: overrides.typeCategory ?? (udtName === "bool" ? "B" : udtName.startsWith("int") ? "N" : "S"),
    domainBaseUdt: null,
    domainBaseSchema: null,
    elementUdt: null,
    elementSchema: null,
    notNull: false,
    defaultExpression: null,
    identity: "",
    generated: "",
    collation: formattedType === "text" ? "default" : null,
    ...overrides,
  };
}

function constraint(name, type, columns) {
  return {
    name,
    type,
    columns,
    referencedSchema: null,
    referencedTable: null,
    referencedColumns: [],
    updateAction: "a",
    deleteAction: "a",
    matchType: "s",
    deferrable: false,
    initiallyDeferred: false,
    validated: true,
  };
}

function primaryIndex(name, columns) {
  return {
    name,
    method: "btree",
    unique: true,
    primary: true,
    valid: true,
    ready: true,
    keyCount: columns.length,
    totalColumnCount: columns.length,
    hasPredicate: false,
    hasExpressions: false,
    backsConstraint: true,
    keys: columns.map((name) => ({ name })),
  };
}
