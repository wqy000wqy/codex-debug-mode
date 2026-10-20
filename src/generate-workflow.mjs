import { writeFile } from 'node:fs/promises';
import { SKILL_TEXT } from './workflow.mjs';
await writeFile(new URL('./skills/debug-mode/SKILL.md',import.meta.url),SKILL_TEXT);
