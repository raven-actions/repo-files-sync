import * as core from '@actions/core';

import { run } from './run.js';

// Thin bootstrap for the bundled action entrypoint (see action.yml -> dist/index.mjs).
// All orchestration lives in run.ts so it can be imported and tested without
// performing a sync as a side effect of the import.
run().catch((err: Error) => {
  core.setFailed(err.message);
  core.debug(String(err));
});
