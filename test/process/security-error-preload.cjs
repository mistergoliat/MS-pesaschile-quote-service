/* global process, setTimeout */
// Only loaded by adversarial process tests. No production import or environment seam.
const mode = process.env.SECURITY_TEST_FAILURE;
const sensitiveFields = ["message", "stack", "detail", "hint", "where", "schema", "table", "column", "constraint", "internalQuery", "query", "routine", "file", "connectionString", "password", "customer", "absolutePath"];
function hostileError() {
  const error = new Error();
  for (const field of sensitiveFields) error[field] = `SECURITY_SENTINEL_${field}_rut_12345678_email@example.invalid_C:/private/token`;
  error.cause = { message: "SECURITY_SENTINEL_cause" };
  error.name = "SECURITY_SENTINEL_name";
  error.code = process.env.SECURITY_TEST_HOSTILE_CODE ? "SECURITY_SENTINEL_code" : "23514";
  error.toString = () => "SECURITY_SENTINEL_toString";
  return error;
}
const pg = require("pg");
if (mode === "init") {
  pg.Pool = class { constructor() { throw hostileError(); } };
} else if (mode === "db") {
  pg.Client.prototype.connect = async function () { throw hostileError(); };
} else if (mode === "schema" || mode === "migration-report") {
  pg.Client.prototype.connect = async function () {};
  pg.Client.prototype.end = async function () {};
  pg.Client.prototype.query = async function () {
    const error = hostileError();
    if (mode === "migration-report") {
      error.code = "P0001";
      error.message = "V1 -> V2 migration exceptions: 1 row(s) violate the frozen mapping; nothing was migrated.\n  11111111-1111-4111-8111-111111111111 document_missing SECURITY_SENTINEL_row";
    }
    throw error;
  };
} else {
  const fastifyPath = require.resolve("fastify");
  const original = require(fastifyPath);
  const wrapped = (...args) => {
    const app = original(...args);
    const listen = app.listen.bind(app);
    app.listen = async (...options) => {
      if (mode === "bind") throw hostileError();
      const result = await listen(...options);
      setTimeout(() => {
        if (mode === "uncaught") throw hostileError();
        void Promise.reject(hostileError());
      }, 20);
      return result;
    };
    return app;
  };
  Object.assign(wrapped, original);
  wrapped.default = wrapped;
  require.cache[fastifyPath].exports = wrapped;
}
