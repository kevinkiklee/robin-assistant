import { migration001 } from './001-initial.ts';
import { migration002 } from './002-entities-relations.ts';
import { migration003 } from './003-fts.ts';
import { migration004 } from './004-lifecycle.ts';
import { migration005 } from './005-events-vec-4096.ts';
import { migration006 } from './006-biographer-progress.ts';
import { migration007 } from './007-predictions-external-id.ts';
import { migration008 } from './008-linear-issue-map.ts';
import { migration009 } from './009-belief-candidates.ts';
import { migration010 } from './010-events-vec-3072.ts';
import { migration011 } from './011-agent-usage.ts';
import { migration012 } from './012-import-dedup-keys.ts';
import { migration013 } from './013-belief-candidate-provenance.ts';
import { migration014 } from './014-correction-topic.ts';
import { migration015 } from './015-hygiene.ts';
import { migration016 } from './016-perf-indexes.ts';
import { migration017 } from './017-drop-hygiene-review.ts';
import { migration018 } from './018-normalize-topics.ts';
import { migration019 } from './019-recall-log-source.ts';
import { migration020 } from './020-candidate-dedup-recall-outcome.ts';
import { migration021 } from './021-dedup-vectors.ts';
import { migration022 } from './022-purge-hook-receipts.ts';
import { migration023 } from './023-events-vec-int8.ts';
import { migration024 } from './024-alerts.ts';
import { migration025 } from './025-agent-outcomes.ts';
import { migration026 } from './026-claim-failures.ts';
import { migration027 } from './027-profile-generated-at.ts';
import { migration028 } from './028-entity-aliases.ts';
import type { Migration } from './types.ts';

export const allMigrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
];
export { applyMigrations } from './runner.ts';
export type { Migration } from './types.ts';
