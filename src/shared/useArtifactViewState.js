import { useState } from 'react';
import { defaultArtifactView, readArtifactView, saveArtifactView } from './artifactViewState.js';
import { tr } from './i18n.js';

const errorMessage = failure => ['ARTIFACT_VIEW_INVALID', 'ARTIFACT_VIEW_CORRUPT'].includes(failure?.code)
  ? failure.message : tr('查看条件未能保存，当前筛选仍可使用。');

function load(deviceId, storage) {
  try { return { deviceId, value: readArtifactView(deviceId, storage), error: '' }; }
  catch (failure) { return { deviceId, value: defaultArtifactView(), error: errorMessage(failure) }; }
}

export default function useArtifactViewState(deviceId = '', storage = globalThis.localStorage) {
  const [state, setState] = useState(() => load(deviceId, storage));
  let snapshot = state;
  if (state.deviceId !== deviceId) {
    snapshot = load(deviceId, storage);
    setState(snapshot);
  }
  const update = changes => {
    const value = { ...snapshot.value, ...changes };
    let error = '';
    try { saveArtifactView(deviceId, value, storage); } catch (failure) { error = errorMessage(failure); }
    setState({ deviceId, value, error });
  };
  return { ...snapshot.value, saveError: snapshot.error, retrySave: () => update({}),
    setQuery: query => update({ query, visibleCount: 30 }),
    setTypeFilter: typeFilter => update({ typeFilter, visibleCount: 30 }),
    setSortOrder: sortOrder => update({ sortOrder, visibleCount: 30 }),
    setVisibleCount: next => update({ visibleCount: typeof next === 'function' ? next(snapshot.value.visibleCount) : next }) };
}
