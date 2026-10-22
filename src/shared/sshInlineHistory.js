export function acceptSshHistoryResult(previous, result) {
  return result.cancelled ? previous : result;
}
