// Picks where reports are kept:
//   DATABASE_URL=postgres(ql)://...  -> Supabase (store-supabase.js): Postgres rows + Storage files
//   anything else / unset            -> local files under DATA_DIR (store-file.js)
// Both return the same report JSON (schema/report.schema.json) and have the same async interface:
//   init, findByClientId, findById, insert, updateGov, list, count, issues, lookup, readMedia
const usePostgres = /^postgres(ql)?(\+\w+)?:\/\//.test(process.env.DATABASE_URL || '');

module.exports = usePostgres ? require('./store-supabase') : require('./store-file');
