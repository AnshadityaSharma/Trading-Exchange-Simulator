// ids.ts — opaque public IDs. 64 random bits, hex, prefixed by kind.
// Why opaque: engine order IDs are per-instrument integers that reset on
// restart — leaking them into the API would make them guessable and
// collide across instruments. Random public IDs survive restarts and
// say nothing about volume (api-contract.md: "opaque strings").

import { randomBytes } from 'node:crypto';

export const newOrderId = (): string => `ord_${randomBytes(8).toString('hex')}`;
export const newFillId = (): string => `fil_${randomBytes(8).toString('hex')}`;
