/**
 * Dry-run adapter: writes the payload that *would* be sent to a local JSONL file.
 * Lets you test routing end-to-end without any CRM credentials.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function createDryRunAdapter(targetName) {
  const file = `output/dry_run_${targetName}.jsonl`;
  return {
    name: targetName,
    isConfigured: () => true,
    async send(lead, meta) {
      await mkdir('output', { recursive: true });
      const externalId = `dry_${randomUUID().slice(0, 8)}`;
      await appendFile(file, `${JSON.stringify({ externalId, target: targetName, meta, lead })}\n`);
      return { externalId };
    },
  };
}
