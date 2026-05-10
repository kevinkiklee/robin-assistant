export function help() {
  console.log(`robin v6 — SurrealDB-first personal AI memory (Phase 1 foundation)

USAGE
  robin migrate           run pending schema migrations
  robin biographer-catchup [--retry-failed]
                          biograph all unprocessed events (or retry failures)
  robin --version | -v
  robin --help    | -h

ENVIRONMENT
  ROBIN_HOME              data directory (default <package_root>/user-data)`);
}
