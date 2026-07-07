// explainer.test.ts — unit tests for the AI explainer. No Postgres, no real
// Anthropic API: the data source is a stub and the messages client is a fake,
// so these assert the prompt content, caching, and the INTERNAL error mapping
// without any network or DB. (The interface stubbing this exercises is exactly
// what CLAUDE.md §3 requires.)

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../server/errors.js';
import {
  AnthropicExplainer,
  buildPrompt,
  type AiMessagesClient,
  type ExplainData,
} from './explainer.js';

/** A completed buy that swept two ask levels below its limit (price improvement). */
const buyData: ExplainData = {
  order: {
    id: 'ord_1',
    side: 'buy',
    type: 'limit',
    price: 245030, // ₹2,450.30 limit
    qty: 4,
    filledQty: 4,
    filledNotional: 245000 * 2 + 245010 * 2, // ₹2,450.00 ×2 and ₹2,450.10 ×2
    status: 'filled',
  },
  fills: [
    { price: 245000, qty: 2 },
    { price: 245010, qty: 2 },
  ],
  instrument: { symbol: 'ACME', name: 'Acme Industries', priceScale: 100 },
};

function fakeMessage(text: string, stopReason: Anthropic.Message['stop_reason'] = 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_reason: stopReason,
    stop_sequence: null,
    content: text ? [{ type: 'text', text, citations: null }] : [],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

function explainerWith(client: AiMessagesClient, data: ExplainData | null = buyData) {
  return new AnthropicExplainer({ client, model: 'claude-opus-4-8', dataSource: async () => data });
}

describe('buildPrompt', () => {
  it('formats prices in rupees and states the fill breakdown and price improvement', () => {
    const { system, user } = buildPrompt(buyData);
    expect(system).toContain('plain-language');
    expect(user).toContain('Acme Industries (ACME)');
    expect(user).toContain('buy limit, 4 share(s)');
    expect(user).toContain('Limit price: ₹2450.30');
    expect(user).toContain('Average fill price: ₹2450.05');
    expect(user).toContain('2 @ ₹2450.00, 2 @ ₹2450.10');
    // Improvement: (245030 - 245005) × ... computed as limit×qty - notional = 245030*4 - 980020 = 100 paise
    expect(user).toContain('Price improvement vs the limit: ₹1.00');
  });

  it('describes an unfilled remainder for a partially canceled market order', () => {
    const { user } = buildPrompt({
      order: { id: 'o', side: 'buy', type: 'market', price: null, qty: 10, filledQty: 3, filledNotional: 735000, status: 'partial_canceled' },
      fills: [{ price: 245000, qty: 3 }],
      instrument: { symbol: 'ACME', name: 'Acme Industries', priceScale: 100 },
    });
    expect(user).not.toContain('Limit price');
    expect(user).toContain('Filled: 3 of 10');
    expect(user).toContain('Unfilled: 7 share(s), canceled');
  });
});

describe('AnthropicExplainer', () => {
  it('generates an explanation and passes the model, system, and user prompt', async () => {
    const create = vi.fn<AiMessagesClient['create']>(async () =>
      fakeMessage('You bought 4 shares of Acme just below your limit.'),
    );
    const explainer = explainerWith({ create });

    const result = await explainer.explainOrder('ord_1');

    expect(result.explanation).toBe('You bought 4 shares of Acme just below your limit.');
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0];
    expect(params.model).toBe('claude-opus-4-8');
    expect(params.system).toContain('retail investor');
    expect(String((params.messages[0]!).content)).toContain('Acme Industries');
  });

  it('caches per order — a second call does not hit the API again', async () => {
    const create = vi.fn(async () => fakeMessage('cached explanation'));
    const explainer = explainerWith({ create });

    const first = await explainer.explainOrder('ord_1');
    const second = await explainer.explainOrder('ord_1');

    expect(second).toBe(first); // same cached object
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps an API failure to an INTERNAL ApiError', async () => {
    const explainer = explainerWith({
      create: async () => {
        throw new Error('rate limited');
      },
    });
    await expect(explainer.explainOrder('ord_1')).rejects.toMatchObject({
      constructor: ApiError,
      status: 500,
      code: 'INTERNAL',
    });
  });

  it('treats a refusal as INTERNAL', async () => {
    const explainer = explainerWith({ create: async () => fakeMessage('', 'refusal') });
    await expect(explainer.explainOrder('ord_1')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('treats empty content as INTERNAL', async () => {
    const explainer = explainerWith({ create: async () => fakeMessage('') });
    await expect(explainer.explainOrder('ord_1')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('returns INTERNAL when the order data has vanished', async () => {
    const explainer = explainerWith({ create: async () => fakeMessage('x') }, null);
    await expect(explainer.explainOrder('gone')).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
