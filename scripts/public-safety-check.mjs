import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "d1porter-output"]);
const allowedSql = new Set(["test/fixtures/source.sql"]);
const textExtensions = new Set(["", ".js", ".mjs", ".json", ".md", ".txt", ".yml", ".yaml", ".sql", ".example", ".gitignore", ".npmignore"]);
const findings = [];
const files = await walk(root);

for (const file of files) {
  const path = file;
  const rel = relative(root, path).replaceAll("\\", "/");
  const info = await stat(path);
  if (info.size > 2 * 1024 * 1024) findings.push(`${rel}: unexpected file larger than 2 MiB`);
  const lower = rel.toLowerCase();
  if (/\.(?:db|sqlite|sqlite3|dump|bak|pem|key|p12|pfx|zip|tar|tgz|gz|7z)$/i.test(lower)) {
    findings.push(`${rel}: prohibited generated, credential, archive, or database file`);
  }
  if (extname(lower) === ".sql" && !allowedSql.has(rel)) findings.push(`${rel}: SQL files are only allowed in the synthetic fixture path`);
  if (!textExtensions.has(extname(lower)) && !["LICENSE", ".editorconfig", ".gitignore", ".npmignore"].includes(rel)) continue;

  const content = await readFile(path, "utf8");
  inspectContent(rel, content);
}

if (findings.length > 0) {
  process.stderr.write(`Public-safety check failed:\n${findings.map((finding) => `- ${finding}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`public-safety check passed for ${files.length} files\n`);
}

function inspectContent(rel, content) {
  const rules = [
    ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
    ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
    ["JWT-like secret", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/],
    ["Supabase project URL", /https?:\/\/[a-z0-9]{20}\.supabase\.co\b/i],
    ["UUID literal", /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
    ["e-mail address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ["absolute home path", /(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/],
    ["private IPv4 address", /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})\b/],
  ];
  for (const [label, pattern] of rules) {
    if (pattern.test(content)) findings.push(`${rel}: possible ${label}`);
  }

  for (const line of content.split(/\r?\n/)) {
    if (/postgres(?:ql)?:\/\/[^\s'"`]+:[^@\s'"`]+@/i.test(line) && !/(?:USER|PASSWORD|HOST|PROJECT|DATABASE|\[|<)/.test(line)) {
      findings.push(`${rel}: possible credential-bearing PostgreSQL URL`);
      break;
    }
    if (/^[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)\s*=\s*\S+/i.test(line) && !/(?:PASSWORD|TOKEN|SECRET|KEY|VALUE|EXAMPLE|PLACEHOLDER|<|\[)/.test(line.split("=").slice(1).join("="))) {
      findings.push(`${rel}: possible secret assigned in an environment file`);
      break;
    }
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(child));
    else output.push(child);
  }
  return output;
}
