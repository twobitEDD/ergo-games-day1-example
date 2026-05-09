import type { SettlementPolicy } from "./contracts";

export class Day1SettlementPolicy implements SettlementPolicy {
  canCreateIntent() {
    return { allowed: true } as const;
  }
}
