// Private, request-local execution context. JSON/MCP arguments cannot activate
// it. Saved requests use it to redact explicitly sensitive runtime bindings and
// to require an independent engine dispatch/receipt for each invocation.
import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage();
export const privateRequestInputs = () => context.getStore() ?? null;
// `environment` lists the values that came from a declared environment
// variable: they are secrets by declaration and keep the full substring scrub.
export const withPrivateRequestInputs = (values, action, { environment = [] } = {}) => context.run({ values, environment }, action);
