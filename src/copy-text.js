import { CliError } from "./errors.js";

/**
 * Parse one physical row emitted by PostgreSQL COPY ... WITH (FORMAT text).
 * COPY text escapes embedded newlines, delimiters, carriage returns and
 * backslashes, so one physical line is exactly one database row.
 */
export function parseCopyTextRow(line, expectedColumns, delimiter = "\t") {
  const rawFields = [];
  let current = "";

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\") {
      current += character;
      if (index + 1 < line.length) current += line[++index];
      continue;
    }
    if (character === delimiter) {
      rawFields.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  rawFields.push(current);

  if (rawFields.length !== expectedColumns) {
    throw new CliError(
      `COPY row had ${rawFields.length} fields; expected ${expectedColumns}. The export was stopped before writing an invalid bundle.`,
    );
  }

  return rawFields.map((raw) => {
    if (raw === "\\N") return null;
    return decodeCopyText(raw);
  });
}

export function decodeCopyText(raw) {
  let output = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character !== "\\") {
      output += character;
      continue;
    }

    if (index + 1 >= raw.length) {
      output += "\\";
      continue;
    }

    const next = raw[++index];
    const named = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
    };
    if (Object.hasOwn(named, next)) {
      output += named[next];
      continue;
    }

    if (next === "x") {
      let hex = "";
      while (index + 1 < raw.length && hex.length < 2 && /[0-9A-Fa-f]/.test(raw[index + 1])) {
        hex += raw[++index];
      }
      if (hex.length > 0) {
        output += String.fromCharCode(Number.parseInt(hex, 16));
      } else {
        output += "x";
      }
      continue;
    }

    if (/[0-7]/.test(next)) {
      let octal = next;
      while (index + 1 < raw.length && octal.length < 3 && /[0-7]/.test(raw[index + 1])) {
        octal += raw[++index];
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
      continue;
    }

    // PostgreSQL treats a backslash before an otherwise unrecognized
    // character as quoting that character.
    output += next;
  }
  return output;
}
