import type {
  TrackerClient,
  TrackerClientFactory,
  TrackerRegistry,
} from "./types.js";

class DefaultTrackerRegistry implements TrackerRegistry {
  private readonly factories = new Map<string, TrackerClientFactory>();

  register(kind: string, factory: TrackerClientFactory): void {
    const key = kind.trim().toLowerCase();
    if (!key) {
      throw new Error("Tracker kind must be non-empty.");
    }
    this.factories.set(key, factory);
  }

  create(kind: string): TrackerClient {
    const key = kind.trim().toLowerCase();
    const factory = this.factories.get(key);
    if (!factory) {
      throw new Error(`No tracker client registered for kind "${kind}".`);
    }
    return factory();
  }

  has(kind: string): boolean {
    return this.factories.has(kind.trim().toLowerCase());
  }

  list(): string[] {
    return [...this.factories.keys()].sort();
  }
}

export function createTrackerRegistry(): TrackerRegistry {
  return new DefaultTrackerRegistry();
}
