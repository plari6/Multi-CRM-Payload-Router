/** Builds the human-readable description attached to CRM lead records. */
export function describeLead(lead, meta) {
  const lines = [
    `Routed by Multi-CRM Payload Router (${meta.tier} budget tier).`,
    `Budget: ${lead.budgetRaw || 'not provided'}${meta.amountUsd !== null ? ` (~$${meta.amountUsd.toLocaleString('en-US')} USD)` : ''}`,
    `Source: ${lead.source}`,
    `Router ID: ${lead.id}`,
  ];
  if (lead.message) lines.push('', lead.message);
  return lines.join('\n').slice(0, 32000);
}
