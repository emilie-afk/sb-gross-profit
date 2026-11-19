// Preloaded by `npm test` (--import): registers the synthetic private rules for every test file.
// GP_TEST_RULES_FILE points at another rules document (the team's private parity run).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPrivateRules } from '../../shared/privateRules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.GP_TEST_RULES_FILE || path.join(here, '..', 'fixtures', 'private-rules.synthetic.json');
setPrivateRules(fs.readFileSync(file, 'utf8'));
