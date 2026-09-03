export function formatPlan(plan) {
  const errors = plan.issues.filter((issue) => issue.level === "error");
  const warnings = plan.issues.filter((issue) => issue.level === "warning");
  const lines = [
    "D1 migration plan",
    "=================",
    `PostgreSQL: ${plain(plan.source.serverVersion ?? "unknown")}`,
    `Schemas: ${plan.source.schemas.map(plain).join(", ")}`,
    `Tables: ${plan.tables.length}`,
    `Blockers: ${errors.length}`,
    `Warnings: ${warnings.length}`,
    "",
  ];

  if (plan.tables.length > 0) {
    lines.push("Table mapping", "-------------");
    for (const table of plan.tables) {
      lines.push(`- ${plain(table.sourceKey)} -> ${plain(table.targetName)} (${table.columns.length} columns, estimated ${plain(table.estimatedRows ?? "?")} rows)`);
    }
    lines.push("");
  }

  if (errors.length > 0) {
    lines.push("Blockers", "--------");
    for (const issue of errors) lines.push(`- [${plain(issue.code)}] ${plain(issue.object)}: ${plain(issue.message)}`);
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("Warnings", "--------");
    for (const issue of warnings) lines.push(`- [${plain(issue.code)}] ${plain(issue.object)}: ${plain(issue.message)}`);
    lines.push("");
  }

  lines.push(
    errors.length > 0
      ? "Export is blocked until the errors above are resolved."
      : "Plan is exportable. Review all warnings before changing the application or writing to a remote D1 database.",
  );
  return `${lines.join("\n")}\n`;
}

export function formatPlanMarkdown(plan) {
  const errors = plan.issues.filter((issue) => issue.level === "error");
  const warnings = plan.issues.filter((issue) => issue.level === "warning");
  const lines = [
    "# D1 migration report",
    "",
    `- PostgreSQL version: \`${markdownCode(plan.source.serverVersion ?? "unknown")}\``,
    `- Selected schemas: ${plan.source.schemas.map((schema) => `\`${markdownCode(schema)}\``).join(", ")}`,
    `- Tables: ${plan.tables.length}`,
    `- Blockers: ${errors.length}`,
    `- Warnings: ${warnings.length}`,
    "",
    "## Table mapping",
    "",
    "| PostgreSQL | D1 | Columns | Estimated rows |",
    "|---|---:|---:|---:|",
  ];
  for (const table of plan.tables) {
    lines.push(`| \`${markdownCode(table.sourceKey)}\` | \`${markdownCode(table.targetName)}\` | ${table.columns.length} | ${markdownCell(table.estimatedRows ?? "?")} |`);
  }
  lines.push("");

  if (errors.length > 0) {
    lines.push("## Blockers", "");
    for (const issue of errors) lines.push(`- **${markdownText(issue.code)}** — \`${markdownCode(issue.object)}\`: ${markdownText(issue.message)}`);
    lines.push("");
  }
  if (warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const issue of warnings) lines.push(`- **${markdownText(issue.code)}** — \`${markdownCode(issue.object)}\`: ${markdownText(issue.message)}`);
    lines.push("");
  }

  lines.push(
    "## Deliberately excluded platform features",
    "",
    "This bundle migrates selected PostgreSQL tables and ordinary indexes. It does not migrate Supabase Auth, Storage, Realtime configuration, Edge Functions, database roles, grants, RLS policies, views, functions, or triggers. Authorization and server-side behavior must be redesigned for the target application.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function plain(value) {
  return String(value).replace(/[\p{Cc}\p{Cf}]/gu, "�");
}

function markdownCode(value) {
  return markdownCell(value).replaceAll("`", "&#96;");
}

function markdownText(value) {
  return markdownCell(value).replaceAll("*", "\\*").replaceAll("_", "\\_");
}

function markdownCell(value) {
  return plain(value).replaceAll("|", "\\|");
}
