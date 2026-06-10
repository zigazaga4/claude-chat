'use client';

import { useSyncExternalStore } from 'react';
import type { PlanUsage, RateLimitUsage } from '@/lib/types';

/**
 * Account-level subscription usage. This is global to the whole app — one
 * Anthropic account serves every chat instance — so it lives in tiny
 * module-level external stores instead of the per-instance reducer. The
 * streaming hook writes snapshots as they arrive; the top-bar UsageMeter
 * subscribes via useSyncExternalStore.
 *
 * Two stores, two sources:
 * - rate-limit store: the SDK's live rate_limit_event (status + window).
 * - plan-usage store: the structured /usage data (per-window percentages,
 *   the same numbers Claude Code's /usage command shows), fetched after
 *   every function-calling loop.
 */

function createSnapshotStore<T>() {
  let current: T | null = null;
  const listeners = new Set<() => void>();
  return {
    set(value: T) {
      current = value;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): T | null {
      return current;
    },
  };
}

// SSR snapshot — no usage data exists on the server.
function getServerSnapshot(): null {
  return null;
}

const rateLimitStore = createSnapshotStore<RateLimitUsage>();
const planUsageStore = createSnapshotStore<PlanUsage>();

export function setRateLimitUsage(usage: RateLimitUsage) {
  rateLimitStore.set(usage);
}

export function useRateLimitUsage(): RateLimitUsage | null {
  return useSyncExternalStore(
    rateLimitStore.subscribe,
    rateLimitStore.getSnapshot,
    getServerSnapshot,
  );
}

export function setPlanUsage(usage: PlanUsage) {
  planUsageStore.set(usage);
}

export function usePlanUsage(): PlanUsage | null {
  return useSyncExternalStore(
    planUsageStore.subscribe,
    planUsageStore.getSnapshot,
    getServerSnapshot,
  );
}
