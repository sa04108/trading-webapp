import { StrategyRegistry } from "../../../../runtime/modules/strategy/application/strategy-registry.js";

declare const __TRADING_EXECUTION_VERSION__: string;
const registry = new StrategyRegistry();
export const formatVersion = 1;
export const nodeMajor = 24;
export const executionVersion = __TRADING_EXECUTION_VERSION__;
export const strategies = registry.list().map((entry) => ({
  strategyId: entry.id,
  name: entry.name,
  description: entry.description,
  version: entry.version,
  parameterSchema: registry.getParameterJsonSchema(entry.id),
}));
export function getStrategy(id: string) { return registry.get(id); }
export { reconcileState } from "./strategy-lifecycle.js";
export const lifecycleAbi = 1;
