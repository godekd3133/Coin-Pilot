/**
 * Finalize an active paper evidence window before its owning process exits.
 *
 * The trading loop and the evidence ledger have separate lifecycles. Keeping
 * this boundary in a small helper makes SIGINT/SIGTERM behavior testable and
 * prevents a dashboard shutdown from leaving an otherwise recoverable ledger
 * looking active until an observer declares it orphaned.
 */
export async function finalizeActivePaperValidation(trader, logger = console) {
  if (trader?.paperValidation?.active !== true ||
    typeof trader.stopPaperValidationSession !== 'function') {
    return null;
  }

  try {
    const stopped = await trader.stopPaperValidationSession();
    logger.log(`🧾 paper validation 종료 기록: ${stopped.stopReason || 'stopped_cleanly'}`);
    return stopped;
  } catch (error) {
    logger.error(`⚠️ paper validation 종료 기록 실패: ${error.message}`);
    return { error };
  }
}
