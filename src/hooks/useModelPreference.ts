'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_MODEL_ID,
  getDefaultEffort,
  isValidEffort,
  isValidModelId,
  type EffortLevel,
  type ModelId,
} from '@/lib/models';

const MODEL_KEY = 'claude-chat:model';
const EFFORT_KEY = 'claude-chat:effort';
const AUTO_EFFORT_KEY = 'claude-chat:autoEffort';

type Pref = { model: ModelId; effort: EffortLevel; autoEffort: boolean };

/** Auto-effort defaults off — it's an opt-in extra round-trip per first message. */
const AUTO_EFFORT_DEFAULT = false;

function readDefault(): Pref {
  const model = DEFAULT_MODEL_ID;
  return { model, effort: getDefaultEffort(model), autoEffort: AUTO_EFFORT_DEFAULT };
}

function readStored(): Pref {
  if (typeof window === 'undefined') return readDefault();
  let model: ModelId = DEFAULT_MODEL_ID;
  let effort: EffortLevel = getDefaultEffort(model);
  let autoEffort = AUTO_EFFORT_DEFAULT;
  try {
    const rawModel = window.localStorage.getItem(MODEL_KEY);
    if (rawModel && isValidModelId(rawModel)) model = rawModel;
    const rawEffort = window.localStorage.getItem(EFFORT_KEY);
    // Every model supports every effort, so a stored value is always usable.
    // Only fall back to the model default when nothing valid is stored.
    effort = rawEffort && isValidEffort(rawEffort) ? rawEffort : getDefaultEffort(model);
    autoEffort = window.localStorage.getItem(AUTO_EFFORT_KEY) === '1';
  } catch {
    /* localStorage unavailable — defaults already in place */
  }
  return { model, effort, autoEffort };
}

/**
 * Model + effort ("thinking power") preference, persisted in localStorage.
 * Adaptive/extended thinking is always on under the hood (decided per model),
 * so the only user choice here is the effort level. Both values are read from
 * storage on mount so they survive a full page reload.
 *
 * Switching the model does NOT change the effort — all models support the full
 * effort ladder, so the user's chosen power carries across models. The
 * per-model default only matters for first use / when no effort is stored.
 */
export function useModelPreference() {
  // Lazy initializer returns server-safe defaults so the SSR HTML matches the
  // first client render; the mount effect below adopts stored values.
  const [state, setState] = useState<Pref>(readDefault);

  useEffect(() => {
    const next = readStored();
    // External-state sync (localStorage) on mount — exactly the "subscribe to
    // an external system" case the react-hooks/set-state-in-effect rule's docs
    // allow, but the rule can't tell, so we waive it on this one line.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((prev) =>
      prev.model === next.model &&
      prev.effort === next.effort &&
      prev.autoEffort === next.autoEffort
        ? prev
        : next,
    );
  }, []);

  const setModel = useCallback((id: ModelId) => {
    setState((prev) => {
      if (prev.model === id) return prev;
      try {
        window.localStorage.setItem(MODEL_KEY, id);
      } catch {
        /* ignore — running in a context without localStorage */
      }
      return { ...prev, model: id };
    });
  }, []);

  const setEffort = useCallback((effort: EffortLevel) => {
    setState((prev) => {
      if (prev.effort === effort) return prev;
      try {
        window.localStorage.setItem(EFFORT_KEY, effort);
      } catch {
        /* ignore */
      }
      return { ...prev, effort };
    });
  }, []);

  const setAutoEffort = useCallback((autoEffort: boolean) => {
    setState((prev) => {
      if (prev.autoEffort === autoEffort) return prev;
      try {
        window.localStorage.setItem(AUTO_EFFORT_KEY, autoEffort ? '1' : '0');
      } catch {
        /* ignore */
      }
      return { ...prev, autoEffort };
    });
  }, []);

  return {
    model: state.model,
    effort: state.effort,
    autoEffort: state.autoEffort,
    setModel,
    setEffort,
    setAutoEffort,
  };
}
