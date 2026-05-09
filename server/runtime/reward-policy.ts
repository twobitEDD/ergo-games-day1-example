import type { RewardPolicy } from "./contracts";

export class Day1RewardPolicy implements RewardPolicy {
  onGameSettled(): void {
    // Day1 stats/reward projection remains store-authoritative for backward compatibility.
  }
}
