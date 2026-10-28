// This driver builds locked registry adapters; its source SHA names laboratory code.
export function islandSourceIdentity(labCommit, { diagnostic = false } = {}) {
  if (labCommit != null && !/^[a-f0-9]{40}$/.test(labCommit)) throw Error('island laboratory source must be an exact commit');
  if (!diagnostic && !labCommit) throw Error('qualified island run requires an exact laboratory commit');
  return { sourceCommit: labCommit ?? null, sourceCommitKind: 'laboratory', labSourceCommit: labCommit ?? null,
    formaSourceCommit: null, formaSourceKind: 'locked-registry' };
}
