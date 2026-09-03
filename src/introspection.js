import { quoteSqlString } from "./util.js";

/**
 * Build one read-only catalog query. It intentionally does not retrieve policy
 * predicates, trigger bodies, function bodies, view definitions, grants, row
 * values, or connection metadata. The planner only needs structural facts.
 */
export function buildIntrospectionSql(schemas) {
  const schemaArray = `ARRAY[${schemas.map(quoteSqlString).join(", ")}]::text[]`;
  return `
WITH selected_tables AS (
  SELECT
    c.oid AS table_oid,
    n.nspname AS schema_name,
    c.relname AS table_name,
    c.relkind::text AS relation_kind,
    c.relrowsecurity AS rls_enabled,
    c.relforcerowsecurity AS rls_forced,
    c.relispartition AS is_partition,
    EXISTS (SELECT 1 FROM pg_inherits AS inh WHERE inh.inhparent = c.oid) AS has_partitions,
    c.relpersistence::text AS persistence,
    GREATEST(c.reltuples::bigint, 0) AS estimated_rows
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY(${schemaArray})
    AND c.relkind IN ('r', 'p')
),
column_sets AS (
  SELECT
    st.table_oid,
    jsonb_agg(
      jsonb_build_object(
        'position', a.attnum,
        'name', a.attname,
        'formattedType', format_type(a.atttypid, a.atttypmod),
        'udtName', t.typname,
        'typeSchema', tn.nspname,
        'typeKind', t.typtype::text,
        'typeCategory', t.typcategory::text,
        'domainBaseUdt', bt.typname,
        'domainBaseSchema', btn.nspname,
        'elementUdt', et.typname,
        'elementSchema', etn.nspname,
        'notNull', a.attnotnull,
        'defaultExpression', pg_get_expr(ad.adbin, ad.adrelid),
        'identity', a.attidentity::text,
        'generated', a.attgenerated::text,
        'collation', CASE WHEN a.attcollation = 0 THEN NULL ELSE coll.collname END
      ) ORDER BY a.attnum
    ) AS columns
  FROM selected_tables AS st
  JOIN pg_attribute AS a ON a.attrelid = st.table_oid
  JOIN pg_type AS t ON t.oid = a.atttypid
  JOIN pg_namespace AS tn ON tn.oid = t.typnamespace
  LEFT JOIN pg_attrdef AS ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  LEFT JOIN pg_type AS bt ON bt.oid = NULLIF(t.typbasetype, 0)
  LEFT JOIN pg_namespace AS btn ON btn.oid = bt.typnamespace
  LEFT JOIN pg_type AS et ON et.oid = NULLIF(t.typelem, 0)
  LEFT JOIN pg_namespace AS etn ON etn.oid = et.typnamespace
  LEFT JOIN pg_collation AS coll ON coll.oid = a.attcollation
  WHERE a.attnum > 0 AND NOT a.attisdropped
  GROUP BY st.table_oid
),
constraint_sets AS (
  SELECT
    st.table_oid,
    jsonb_agg(
      jsonb_build_object(
        'name', con.conname,
        'type', con.contype::text,
        'columns', COALESCE((
          SELECT jsonb_agg(att.attname ORDER BY key_col.ordinality)
          FROM unnest(con.conkey) WITH ORDINALITY AS key_col(attnum, ordinality)
          JOIN pg_attribute AS att ON att.attrelid = con.conrelid AND att.attnum = key_col.attnum
        ), '[]'::jsonb),
        'referencedSchema', ref_ns.nspname,
        'referencedTable', ref_table.relname,
        'referencedColumns', COALESCE((
          SELECT jsonb_agg(att.attname ORDER BY ref_col.ordinality)
          FROM unnest(con.confkey) WITH ORDINALITY AS ref_col(attnum, ordinality)
          JOIN pg_attribute AS att ON att.attrelid = con.confrelid AND att.attnum = ref_col.attnum
        ), '[]'::jsonb),
        'updateAction', con.confupdtype::text,
        'deleteAction', con.confdeltype::text,
        'matchType', con.confmatchtype::text,
        'deferrable', con.condeferrable,
        'initiallyDeferred', con.condeferred,
        'validated', con.convalidated
      ) ORDER BY con.contype, con.conname
    ) AS constraints
  FROM selected_tables AS st
  JOIN pg_constraint AS con ON con.conrelid = st.table_oid
  LEFT JOIN pg_class AS ref_table ON ref_table.oid = con.confrelid
  LEFT JOIN pg_namespace AS ref_ns ON ref_ns.oid = ref_table.relnamespace
  GROUP BY st.table_oid
),
index_sets AS (
  SELECT
    st.table_oid,
    jsonb_agg(
      jsonb_build_object(
        'name', index_class.relname,
        'method', access_method.amname,
        'unique', idx.indisunique,
        'primary', idx.indisprimary,
        'valid', idx.indisvalid,
        'ready', idx.indisready,
        'keyCount', idx.indnkeyatts,
        'totalColumnCount', idx.indnatts,
        'hasPredicate', idx.indpred IS NOT NULL,
        'hasExpressions', idx.indexprs IS NOT NULL,
        'backsConstraint', EXISTS (
          SELECT 1 FROM pg_constraint AS backing WHERE backing.conindid = idx.indexrelid
        ),
        'keys', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('name', key_att.attname)
            ORDER BY key_col.ordinality
          )
          FROM unnest(idx.indkey) WITH ORDINALITY AS key_col(attnum, ordinality)
          LEFT JOIN pg_attribute AS key_att
            ON key_att.attrelid = idx.indrelid AND key_att.attnum = key_col.attnum
          WHERE key_col.ordinality <= idx.indnkeyatts
        ), '[]'::jsonb)
      ) ORDER BY index_class.relname
    ) AS indexes
  FROM selected_tables AS st
  JOIN pg_index AS idx ON idx.indrelid = st.table_oid
  JOIN pg_class AS index_class ON index_class.oid = idx.indexrelid
  JOIN pg_am AS access_method ON access_method.oid = index_class.relam
  GROUP BY st.table_oid
),
policy_counts AS (
  SELECT st.table_oid, count(*)::int AS policy_count
  FROM selected_tables AS st
  JOIN pg_policies AS policies
    ON policies.schemaname = st.schema_name AND policies.tablename = st.table_name
  GROUP BY st.table_oid
),
trigger_counts AS (
  SELECT st.table_oid, count(*)::int AS trigger_count
  FROM selected_tables AS st
  JOIN pg_trigger AS trigger_row
    ON trigger_row.tgrelid = st.table_oid AND NOT trigger_row.tgisinternal
  GROUP BY st.table_oid
),
enum_types AS (
  SELECT
    type_ns.nspname AS schema_name,
    enum_type.typname AS type_name,
    jsonb_agg(enum_value.enumlabel ORDER BY enum_value.enumsortorder) AS labels
  FROM pg_type AS enum_type
  JOIN pg_namespace AS type_ns ON type_ns.oid = enum_type.typnamespace
  JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
  WHERE type_ns.nspname = ANY(${schemaArray})
  GROUP BY type_ns.nspname, enum_type.typname
)
SELECT jsonb_build_object(
  'serverVersion', current_setting('server_version'),
  'serverVersionNum', current_setting('server_version_num'),
  'tables', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'schema', st.schema_name,
        'name', st.table_name,
        'relationKind', st.relation_kind,
        'rlsEnabled', st.rls_enabled,
        'rlsForced', st.rls_forced,
        'isPartition', st.is_partition,
        'hasPartitions', st.has_partitions,
        'persistence', st.persistence,
        'estimatedRows', st.estimated_rows::text,
        'columns', COALESCE(cs.columns, '[]'::jsonb),
        'constraints', COALESCE(cons.constraints, '[]'::jsonb),
        'indexes', COALESCE(ix.indexes, '[]'::jsonb),
        'policyCount', COALESCE(pol.policy_count, 0),
        'triggerCount', COALESCE(trg.trigger_count, 0)
      ) ORDER BY st.schema_name, st.table_name
    )
    FROM selected_tables AS st
    LEFT JOIN column_sets AS cs ON cs.table_oid = st.table_oid
    LEFT JOIN constraint_sets AS cons ON cons.table_oid = st.table_oid
    LEFT JOIN index_sets AS ix ON ix.table_oid = st.table_oid
    LEFT JOIN policy_counts AS pol ON pol.table_oid = st.table_oid
    LEFT JOIN trigger_counts AS trg ON trg.table_oid = st.table_oid
  ), '[]'::jsonb),
  'viewCount', (
    SELECT count(*)::int
    FROM pg_class AS view_class
    JOIN pg_namespace AS view_ns ON view_ns.oid = view_class.relnamespace
    WHERE view_ns.nspname = ANY(${schemaArray}) AND view_class.relkind IN ('v', 'm')
  ),
  'functionCount', (
    SELECT count(*)::int
    FROM pg_proc AS fn
    JOIN pg_namespace AS fn_ns ON fn_ns.oid = fn.pronamespace
    WHERE fn_ns.nspname = ANY(${schemaArray})
  ),
  'enums', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object('schema', schema_name, 'name', type_name, 'labels', labels)
      ORDER BY schema_name, type_name
    ) FROM enum_types
  ), '[]'::jsonb),
  'extensionCount', (SELECT count(*)::int FROM pg_extension)
)::text;
`;
}
