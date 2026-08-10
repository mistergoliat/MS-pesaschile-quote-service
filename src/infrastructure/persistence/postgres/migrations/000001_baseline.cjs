exports.up = (pgm) => {
  pgm.createSchema("quote_service", { ifNotExists: true });
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
};

exports.down = (pgm) => {
  pgm.dropSchema("quote_service", { ifExists: true, cascade: true });
};
