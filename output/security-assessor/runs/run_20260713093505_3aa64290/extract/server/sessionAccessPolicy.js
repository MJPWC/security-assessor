export function evaluateSessionAccess({ sessionMeta, userId, sessionToken }) {
  if (!sessionMeta) {
    return { allowed: false, status: 404, reason: 'Session not found' };
  }

  if (!userId || sessionMeta.ownerId !== userId) {
    return { allowed: false, status: 404, reason: 'Session not found' };
  }

  if (!sessionMeta.sessionToken || sessionMeta.sessionToken !== sessionToken) {
    return { allowed: false, status: 403, reason: 'Invalid or missing session token' };
  }

  return { allowed: true };
}
