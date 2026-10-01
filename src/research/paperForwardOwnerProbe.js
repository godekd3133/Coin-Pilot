function validPid(pid) {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0;
}

/** Signal-zero reports PID existence only; it does not authenticate process ownership. */
export function observeProcessExistence(pid, signalZero = process.kill) {
  if (!validPid(pid)) return { pid: null, exists: null, observation: 'invalid_pid' };
  try {
    signalZero(pid, 0);
    return { pid, exists: true, observation: 'pid_exists_identity_unverified' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { pid, exists: false, observation: 'process_missing' };
    if (error?.code === 'EPERM') return { pid, exists: true, observation: 'exists_permission_denied' };
    return { pid, exists: null, observation: 'probe_error_unknown' };
  }
}
