// explainer.ts — the AI explainability interface.
// Why an interface: CLAUDE.md §3 requires the AI layer isolated behind one,
// so the server and tests never touch the Anthropic API directly. Phase 4
// provides the real implementation; until then (and whenever no API key is
// configured) the stub declares itself unavailable, which the contract maps
// to an INTERNAL error while all order data stays served by the normal API.

import { ApiError } from '../server/errors.js';

export interface ExplainResult {
  explanation: string;
  generatedAt: string;
}

export interface Explainer {
  /** Plain-language explanation of an order's outcome. Cached per order. */
  explainOrder(orderId: string): Promise<ExplainResult>;
}

export class UnavailableExplainer implements Explainer {
  async explainOrder(): Promise<ExplainResult> {
    throw new ApiError(500, 'INTERNAL', 'explanations are not available on this deployment');
  }
}
