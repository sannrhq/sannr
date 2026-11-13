// The detached sender for the daily usage document (lib/telemetry.mjs). A
// command starts it and never waits for it; it POSTs one receipt's exact bytes
// to the fixed destination, records the outcome and exits. It prints nothing.
import { deliver } from './telemetry.mjs';

// A hard stop well beyond the request timeout, so a stuck process cannot linger.
setTimeout(() => process.exit(0), 15_000).unref();
const receipt = process.argv[2];
if (typeof receipt === 'string' && receipt.endsWith('.json')) await deliver(receipt);
