import assert from "node:assert/strict";
import test from "node:test";
import { resolvePgEnvironment } from "../src/psql.js";

test("passes documented libpq settings but not unrelated PG-prefixed secrets", () => {
  const keys = ["D1PORTER_TEST_URL", "DATABASE_URL", "PGHOST", "PGUSER", "PGPASSWORD", "PG_PRIVATE_TOKEN"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.D1PORTER_TEST_URL;
    delete process.env.DATABASE_URL;
    process.env.PGHOST = "db.example.invalid";
    process.env.PGUSER = "sample_user";
    process.env.PGPASSWORD = "synthetic-password";
    process.env.PG_PRIVATE_TOKEN = "must-not-be-forwarded";

    const { env, secrets } = resolvePgEnvironment("D1PORTER_TEST_URL");
    assert.equal(env.PGHOST, "db.example.invalid");
    assert.equal(env.PGUSER, "sample_user");
    assert.equal(env.PGPASSWORD, "synthetic-password");
    assert.equal(env.PG_PRIVATE_TOKEN, undefined);
    assert.deepEqual(secrets, ["synthetic-password"]);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
